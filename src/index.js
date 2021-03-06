"use strict";

var inherits = require("inherits");
var iframe = require("iframe");
var events = require("events");
var request = require("superagent");
var detective = require("detective");
var createCache = require("browser-module-cache");

module.exports = function(opts) {
  return new Sandbox(opts);
};

function Sandbox(opts) {
  var self = this;
  if (!opts) opts = {};
  this.name = opts.name;
  this.container = opts.container || document.body;
  this.iframeHead = opts.iframeHead || "";
  this.iframeBody = opts.iframeBody || "";
  this.iframeSandbox = opts.iframeSandbox || "";
  this.cdn = opts.cdn || window.location.protocol + "//" + window.location.host;
  this.iframe = iframe({
    container: this.container,
    scrollingDisabled: true,
    sandboxAttributes: this.iframeSandbox
  });
  this.iframeStyle =
    "<style type='text/css'>" +
    "html, body { margin: 0; padding: 0; border: 0; }\n" +
    opts.iframeStyle +
    "</style>";
  this.cache = createCache(opts.cacheOpts);
}

inherits(Sandbox, events.EventEmitter);

Sandbox.prototype.bundle = function(entry, preferredVersions) {
  if (!preferredVersions) preferredVersions = {};
  var self = this;

  var modules = detective(entry);

  // filter empty strings etc. (maybe should be moved to detective?)
  modules = modules.filter(function(mod) {
    return mod;
  });

  self.emit("bundleStart");

  if (modules.length === 0) return makeIframe();

  var allBundles = "";
  var packages = [];

  self.cache.get(function(err, cached) {
    if (err) {
      self.emit("bundleEnd");
      return err;
    }

    var download = [];
    modules.forEach(function(module) {
      if (module.indexOf("@") <= 0) {
        module = module + "@" + (preferredVersions[module] || "latest");
      } else {
        entry = entry.replace(module, module.split("@")[0]);
      }

      if (cached[module]) {
        var tokens = module.split("@");
        var bundle = !tokens[0]
          ? cached[module]["bundle"].replace(
              encodeURIComponent(tokens[1]),
              tokens[1]
            )
          : cached[module]["bundle"];
        allBundles += bundle;
        packages.push(cached[module]["package"]);
      } else {
        download.push(module);
      }
    });

    if (download.length === 0) {
      self.emit("modules", packages);
      return makeIframe(allBundles);
    }

    var body = {
      options: {
        debug: true
      },
      dependencies: {}
    };

    download.map(function(module) {
      var tokens = module.split("@");
      var name, version;
      if (!tokens[0]) {
        name = "@" + tokens[1];
        // TODO: remove if upper line is not producing errors
        // name = "@" + encodeURIComponent(tokens[1]);
        version = tokens[2];
      } else {
        name = tokens[0];
        version = tokens[1];
      }
      body.dependencies[name] = version;
    });

    request
      .post(self.cdn + "/multi")
      .send(body)
      .end(downloadedModules);
  });

  function downloadedModules(err, resp) {
    if (err) {
      var errText = err.response && err.response.text;

      self.emit("bundleError", errText);
      return errText;
    } else if (resp.statusCode == 500) {
      self.emit("bundleError", resp.text);
      return resp.text;
    }

    var json = resp.body;

    // fix json properties to also hold the package version
    // e.g.
    // "foo": {
    //  "package": {
    //    "version": "1.0.0"
    //  }
    // }
    // to:
    // "foo@1.0.0": { ... }
    //
    // NOTE: "foo@latest" is never cached because browserify-cdn
    // always returns a valid semver :)
    Object.keys(json).forEach(function(module) {
      var existing = json[module];
      json[decodeURIComponent(module) + "@" + existing.package.version] =
        json[module];
      delete json[module];
    });

    Object.keys(json).forEach(function(module) {
      var tokens = module.split("@");
      var bundle = !tokens[0]
        ? json[module]["bundle"].replace(
            encodeURIComponent(tokens[1]),
            tokens[1]
          )
        : json[module]["bundle"];
      allBundles += bundle;
      packages.push(json[module]["package"]);
    });

    self.cache.put(json, function() {
      self.emit("modules", packages);
      makeIframe(allBundles);
    });
  }

  function makeIframe(script) {
    script = script || "";
    self.emit("bundleContent", script);

    script = script + entry;

    // setTimeout is because iframes report inaccurate window.innerWidth/innerHeight, even after DOMContentLoaded!
    script = "setTimeout(function(){\n;" + script + "\n;}, 0)";

    // check for </script> in code to use faster way executing script (https://github.com/maxogden/browser-module-sandbox/issues/13)
    var scriptTag =
      script.indexOf("</script>") === -1
        ? '<script type="text/javascript">' + script + "</script>"
        : '<script type="text/javascript" src="data:text/javascript;charset=UTF-8,' +
          encodeURIComponent(script) +
          '"></script>';

    var body = self.iframeBody + scriptTag;
    var html = {
      head: self.iframeHead + self.iframeStyle,
      body: body,
      script: script,
      sandboxAttributes: self.iframeSandbox
    };
    if (self.name) html.name = self.name;
    self.iframe.setHTML(html);
    self.emit("bundleEnd", html);
  }
};
