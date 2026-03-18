package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/jtejido/sourceafis"
	"github.com/jtejido/sourceafis/config"
	"github.com/jtejido/sourceafis/templates"
)

const (
	defaultPort          = "4000"
	defaultMatchTreshold = 40.0
	fingerprintDPI       = 500.0
	minPNGBytes          = 1024
)

type app struct {
	supabaseURL string
	serviceKey  string
	threshold   float64
	httpClient  *http.Client
	logger      *sourceafis.DefaultTransparencyLogger
}

type noopTransparency struct{}

func (n *noopTransparency) Accepts(string) bool { return false }
func (n *noopTransparency) Accept(string, string, []byte) error {
	return nil
}

type enrollRequest struct {
	Name                string `json:"name"`
	LastName            string `json:"lastname"`
	Email               string `json:"email"`
	FingerprintTemplate string `json:"fingerprintTemplate"`
}

type authRequest struct {
	FingerprintTemplate string `json:"fingerprintTemplate"`
}

type userRecord struct {
	ID                  string  `json:"id"`
	Name                string  `json:"name"`
	LastName            string  `json:"lastname"`
	Email               string  `json:"email"`
	FingerprintTemplate *string `json:"fingerprint_template,omitempty"`
	CreatedAt           string  `json:"created_at,omitempty"`
	EnrolledAt          string  `json:"enrolled_at,omitempty"`
}

type authLogInsert struct {
	MatchedUserID *string `json:"matched_user_id,omitempty"`
	MatchScore    float64 `json:"match_score"`
	Success       bool    `json:"success"`
	AttemptedAt   string  `json:"attempted_at"`
}

type supabaseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
	Details string `json:"details"`
}

func main() {
	_ = godotenv.Load()
	config.LoadDefaultConfig()

	supabaseURL := strings.TrimSpace(os.Getenv("SUPABASE_URL"))
	serviceKey := strings.TrimSpace(os.Getenv("SUPABASE_SERVICE_ROLE_KEY"))
	if supabaseURL == "" || serviceKey == "" {
		log.Fatal("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend/.env")
	}

	threshold := defaultMatchTreshold
	if value := strings.TrimSpace(os.Getenv("MATCH_THRESHOLD")); value != "" {
		if parsed, err := parseFloat(value); err == nil {
			threshold = parsed
		}
	}

	api := &app{
		supabaseURL: strings.TrimSuffix(supabaseURL, "/"),
		serviceKey:  serviceKey,
		threshold:   threshold,
		httpClient: &http.Client{
			Timeout: 25 * time.Second,
		},
		logger: sourceafis.NewTransparencyLogger(&noopTransparency{}),
	}

	router := gin.Default()
	router.Use(corsMiddleware(strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))))

	router.GET("/api/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true, "threshold": api.threshold})
	})

	router.GET("/api/users", api.getUsers)
	router.POST("/api/users/enroll", api.enrollUser)
	router.POST("/api/auth/fingerprint", api.authenticateFingerprint)

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = defaultPort
	}

	log.Printf("Go fingerprint API running on http://localhost:%s", port)
	if err := router.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}

func (a *app) enrollUser(c *gin.Context) {
	var req enrollRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON payload"})
		return
	}

	req.Name = strings.TrimSpace(req.Name)
	req.LastName = strings.TrimSpace(req.LastName)
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if req.Name == "" || req.LastName == "" || req.Email == "" || strings.TrimSpace(req.FingerprintTemplate) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name, lastname, email and fingerprintTemplate are required"})
		return
	}

	templateString, _, err := a.extractTemplate(req.FingerprintTemplate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	payload := map[string]any{
		"name":                 req.Name,
		"lastname":             req.LastName,
		"email":                req.Email,
		"fingerprint_template": templateString,
	}

	rows, status, err := a.insertUsers(c.Request.Context(), payload)
	if err != nil {
		if status == http.StatusConflict {
			c.JSON(http.StatusConflict, gin.H{"error": "A user with this email already exists"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(rows) == 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "No user was returned by Supabase"})
		return
	}

	created := rows[0]
	c.JSON(http.StatusCreated, gin.H{
		"id":          created.ID,
		"name":        created.Name,
		"lastname":    created.LastName,
		"email":       created.Email,
		"enrolled_at": created.EnrolledAt,
	})
}

func (a *app) authenticateFingerprint(c *gin.Context) {
	var req authRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON payload"})
		return
	}

	if strings.TrimSpace(req.FingerprintTemplate) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "fingerprintTemplate is required"})
		return
	}

	_, probeTemplate, err := a.extractTemplate(req.FingerprintTemplate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	users, err := a.listUsersWithTemplate(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if len(users) == 0 {
		_ = a.insertAuthLog(c.Request.Context(), nil, 0, false)
		c.JSON(http.StatusUnauthorized, gin.H{"message": "No match found for this fingerprint sample.", "score": 0.0, "threshold": a.threshold})
		return
	}

	matcher, err := sourceafis.NewMatcher(a.logger, probeTemplate)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to initialise matcher"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()

	var bestUser *userRecord
	bestScore := 0.0
	for i := range users {
		rec := users[i]
		if rec.FingerprintTemplate == nil || *rec.FingerprintTemplate == "" {
			continue
		}
		candidate, err := deserializeTemplate(*rec.FingerprintTemplate)
		if err != nil {
			continue
		}
		score := matcher.Match(ctx, candidate)
		if bestUser == nil || score > bestScore {
			bestScore = score
			bestUser = &rec
		}
	}

	if bestUser == nil || bestScore < a.threshold {
		_ = a.insertAuthLog(c.Request.Context(), nil, bestScore, false)
		c.JSON(http.StatusUnauthorized, gin.H{
			"message":   "No match found for this fingerprint sample.",
			"score":     round4(bestScore),
			"threshold": a.threshold,
		})
		return
	}

	_ = a.insertAuthLog(c.Request.Context(), &bestUser.ID, bestScore, true)
	c.JSON(http.StatusOK, gin.H{
		"authenticated": true,
		"score":         round4(bestScore),
		"threshold":     a.threshold,
		"user": gin.H{
			"id":       bestUser.ID,
			"name":     bestUser.Name,
			"lastname": bestUser.LastName,
			"email":    bestUser.Email,
		},
	})
}

func (a *app) getUsers(c *gin.Context) {
	users, err := a.listUsers(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, users)
}

func (a *app) extractTemplate(base64PNG string) (string, *templates.SearchTemplate, error) {
	pngBytes, err := decodePNGBase64(base64PNG)
	if err != nil {
		return "", nil, err
	}
	if len(pngBytes) < minPNGBytes {
		zeroBytes(pngBytes)
		return "", nil, errors.New("fingerprintTemplate PNG is too small to be valid")
	}

	cfg, format, err := image.DecodeConfig(bytes.NewReader(pngBytes))
	if err != nil || format != "png" {
		zeroBytes(pngBytes)
		return "", nil, errors.New("fingerprintTemplate must be a valid base64 PNG")
	}
	if cfg.Width < 80 || cfg.Height < 80 {
		zeroBytes(pngBytes)
		return "", nil, errors.New("fingerprintTemplate PNG dimensions are too small")
	}

	img, _, err := image.Decode(bytes.NewReader(pngBytes))
	if err != nil {
		zeroBytes(pngBytes)
		return "", nil, errors.New("failed to decode PNG image")
	}

	sourceImg, err := sourceafis.NewFromImage(img, sourceafis.WithResolution(fingerprintDPI))
	if err != nil {
		zeroBytes(pngBytes)
		return "", nil, fmt.Errorf("failed to process image: %w", err)
	}

	creator := sourceafis.NewTemplateCreator(a.logger)
	tpl, err := creator.Template(sourceImg)
	if err != nil {
		zeroBytes(pngBytes)
		return "", nil, fmt.Errorf("failed to extract fingerprint template: %w", err)
	}

	serialized, err := cbor.Marshal(tpl)
	if err != nil {
		zeroBytes(pngBytes)
		return "", nil, fmt.Errorf("failed to serialize template: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(serialized)

	zeroBytes(pngBytes)
	return encoded, tpl, nil
}

func deserializeTemplate(serialized string) (*templates.SearchTemplate, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(serialized))
	if err != nil {
		return nil, err
	}
	var tpl templates.SearchTemplate
	if err := cbor.Unmarshal(decoded, &tpl); err != nil {
		return nil, err
	}
	if len(tpl.Minutiae) == 0 {
		return nil, errors.New("empty template")
	}
	return &tpl, nil
}

func decodePNGBase64(input string) ([]byte, error) {
	value := strings.TrimSpace(input)
	if value == "" {
		return nil, errors.New("fingerprintTemplate is required")
	}
	if comma := strings.Index(value, ","); strings.HasPrefix(value, "data:image/") && comma > 0 {
		value = value[comma+1:]
	}
	value = strings.TrimSpace(value)

	decoders := []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	}
	for _, enc := range decoders {
		if decoded, err := enc.DecodeString(value); err == nil {
			return decoded, nil
		}
	}
	return nil, errors.New("fingerprintTemplate must be base64-encoded PNG")
}

func zeroBytes(data []byte) {
	for i := range data {
		data[i] = 0
	}
}

func parseFloat(v string) (float64, error) {
	var out float64
	_, err := fmt.Sscanf(v, "%f", &out)
	return out, err
}

func round4(v float64) float64 {
	return float64(int(v*10000+0.5)) / 10000
}

func corsMiddleware(originList string) gin.HandlerFunc {
	allowed := map[string]bool{}
	allowAnyLoopbackOrigin := false
	for _, origin := range strings.Split(originList, ",") {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			allowed[origin] = true
			if strings.Contains(origin, "localhost") {
				allowed[strings.Replace(origin, "localhost", "127.0.0.1", 1)] = true
				allowAnyLoopbackOrigin = true
			}
			if strings.Contains(origin, "127.0.0.1") {
				allowed[strings.Replace(origin, "127.0.0.1", "localhost", 1)] = true
				allowAnyLoopbackOrigin = true
			}
		}
	}

	isLoopbackOrigin := func(origin string) bool {
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		host := strings.Split(u.Host, ":")[0]
		return host == "localhost" || host == "127.0.0.1"
	}

	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		originAllowed := len(allowed) == 0 || allowed[origin] || (allowAnyLoopbackOrigin && isLoopbackOrigin(origin))
		if origin != "" && originAllowed {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			c.Writer.Header().Set("Vary", "Origin")
		}
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, apikey")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

func (a *app) insertUsers(ctx context.Context, payload map[string]any) ([]userRecord, int, error) {
	respBody, status, err := a.callSupabase(ctx, http.MethodPost, "/rest/v1/users", url.Values{"select": {"id,name,lastname,email,enrolled_at"}}, payload, true)
	if err != nil {
		return nil, status, err
	}
	rows := make([]userRecord, 0)
	if err := json.Unmarshal(respBody, &rows); err != nil {
		return nil, http.StatusInternalServerError, err
	}
	return rows, status, nil
}

func (a *app) listUsersWithTemplate(ctx context.Context) ([]userRecord, error) {
	query := url.Values{}
	query.Set("select", "id,name,lastname,email,fingerprint_template")
	query.Set("fingerprint_template", "not.is.null")

	respBody, _, err := a.callSupabase(ctx, http.MethodGet, "/rest/v1/users", query, nil, false)
	if err != nil {
		return nil, err
	}
	rows := make([]userRecord, 0)
	if err := json.Unmarshal(respBody, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func (a *app) listUsers(ctx context.Context) ([]userRecord, error) {
	query := url.Values{}
	query.Set("select", "id,name,lastname,email,created_at")
	query.Set("order", "created_at.desc")

	respBody, _, err := a.callSupabase(ctx, http.MethodGet, "/rest/v1/users", query, nil, false)
	if err != nil {
		return nil, err
	}
	rows := make([]userRecord, 0)
	if err := json.Unmarshal(respBody, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

func (a *app) insertAuthLog(ctx context.Context, matchedUserID *string, score float64, success bool) error {
	entry := authLogInsert{
		MatchedUserID: matchedUserID,
		MatchScore:    round4(score),
		Success:       success,
		AttemptedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	_, _, err := a.callSupabase(ctx, http.MethodPost, "/rest/v1/auth_logs", nil, entry, false)
	return err
}

func (a *app) callSupabase(ctx context.Context, method, path string, query url.Values, payload any, returnRepresentation bool) ([]byte, int, error) {
	requestURL := a.supabaseURL + path
	if len(query) > 0 {
		requestURL += "?" + query.Encode()
	}

	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return nil, http.StatusInternalServerError, err
		}
		body = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	req.Header.Set("apikey", a.serviceKey)
	req.Header.Set("Authorization", "Bearer "+a.serviceKey)
	req.Header.Set("Content-Type", "application/json")
	if returnRepresentation {
		req.Header.Set("Prefer", "return=representation")
	}

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return respBody, resp.StatusCode, nil
	}

	var sbErr supabaseError
	_ = json.Unmarshal(respBody, &sbErr)
	if sbErr.Code == "23505" {
		return nil, http.StatusConflict, errors.New(sbErr.Message)
	}
	if sbErr.Message != "" {
		return nil, resp.StatusCode, fmt.Errorf("supabase error: %s", sbErr.Message)
	}
	return nil, resp.StatusCode, fmt.Errorf("supabase request failed with status %d", resp.StatusCode)
}
