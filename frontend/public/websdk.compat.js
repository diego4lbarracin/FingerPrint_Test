(function () {
  if (!globalThis.WebSdk || !globalThis.WebSdk.WebChannelClient) {
    return;
  }

  var OriginalWebChannelClient = globalThis.WebSdk.WebChannelClient;

  globalThis.WebSdk.WebChannelClient = function WebChannelClientCompat() {
    var instance = new OriginalWebChannelClient(...arguments);
    var connected = false;

    return new Proxy(instance, {
      get: function (target, prop, receiver) {
        if (prop === "isConnected") {
          return function () {
            return connected;
          };
        }

        if (prop === "disconnect") {
          return function () {
            connected = false;
            if (typeof target.disconnect === "function") {
              return target.disconnect();
            }
          };
        }

        return Reflect.get(target, prop, receiver);
      },
      set: function (target, prop, value, receiver) {
        if (prop === "onConnectionSucceed" && typeof value === "function") {
          var wrappedSucceed = function () {
            connected = true;
            return value.apply(this, arguments);
          };
          return Reflect.set(target, prop, wrappedSucceed, receiver);
        }

        if (prop === "onConnectionFailed" && typeof value === "function") {
          var wrappedFailed = function () {
            connected = false;
            return value.apply(this, arguments);
          };
          return Reflect.set(target, prop, wrappedFailed, receiver);
        }

        return Reflect.set(target, prop, value, receiver);
      },
    });
  };
})();
