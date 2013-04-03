var data = require("sdk/self").data;
var panel = require("sdk/panel");
var widget = require("sdk/widget");

function toType(obj) {
  return ({}).toString.call(obj).match(/\s([a-zA-Z]+)/)[1].toLowerCase()
}

function include_thirdparty(lib_name) {
    const { Cc, Ci } = require("chrome");
    
    var mozIJSSubScriptLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
	.getService(Ci.mozIJSSubScriptLoader);

    var lib_mod = {};
    mozIJSSubScriptLoader.loadSubScript(data.url("thirdparty/" + lib_name), lib_mod);
    return lib_mod;
}

var zxcvbn = require('./thirdparty/zxcvbn/zxcvbn.js').zxcvbn;
var tld = require('./thirdparty/tldjs/index.js');
var sprintf = require('./thirdparty/sprintf-0.7-beta1.js').sprintf;

var sjcl = include_thirdparty("sjcl.js").sjcl;
var CryptoJS = include_thirdparty("sha1.js").CryptoJS;

//var $ = include_thirdparty("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js");
//var voodoo = include_thirdparty("voodoo/voodoo.js");

var kk = sprintf("%s: testing", "mmorpg");
console.log("Here here: in sprintf: " + JSON.stringify(kk));

// Construct a panel, loading its content from the "text-entry.html"
// file in the "data" directory, and loading the "get-text.js" script
// into it.
var appu_menu_panel = panel.Panel({
	width: 500,
	height: 500,
	contentURL: data.url("popup.html"),
	contentScriptFile: [ 
			    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
			    data.url("thirdparty/bootstrap/js/bootstrap.js"),
			    data.url("popup.js"), 
			     ]
    });
 
// Create a widget, and attach the panel to it, so the panel is
// shown when the user clicks the widget.
var appu_menu_widget = widget.Widget({
	label: "Appu: Reduce privacy footprint on the web",
	id: "appu-menu-widget",
	contentURL: data.url("images/appu_new.ico"),
	panel: appu_menu_panel
    });

appu_menu_panel.port.on("displayed", function(m) {
	//console.log("Here here: YuHoo: Appu Menu has been displayed: height: " + m.height + ", width: " + m.width);
	appu_menu_panel.resize(320, m.height + 35);
	appu_menu_panel.port.emit("resized");
	//console.log("Here here: New panel height: " + appu_menu_panel.height + ", width: " + appu_menu_panel.width);
	//console.log("Here here: New panel isShowing: " + appu_menu_panel.isShowing);
    });

//console.log("Here here: Finishing main.js");