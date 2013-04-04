var data = require("sdk/self").data;
var panel = require("sdk/panel");
var widget = require("sdk/widget");
var page_worker = require("sdk/page-worker");
var tabs = require("sdk/tabs");

Object.size = function(obj) {
    var size = 0, key;
    for (key in obj) {
        if (obj.hasOwnProperty(key)) size++;
    }
    return size;
};

var ext_id = '';

var pii_vault = { "options" : {}, "config": {}};

var pending_warnings = {};
var pending_pi_fetch = {};

//If user says remind me later
var report_reminder_interval = 30;

//Report check interval in minutes
var report_check_interval = 5;

//Do background tasks like send undelivered reports,
//feedbacks etc
var bg_tasks_interval = 10;

//Is user processing report?
var is_report_tab_open = 0;

//All open report pages. These are useful to send updates to stats
var report_tab_ids = [];

// Which text report to be shown in which tab-id
var text_report_tab_ids = {};

//All open "My footprint" pages. These are useful to send updates to stats
var myfootprint_tab_ids = [];

var template_processing_tabs = {};

//Was an undelivered report attempted to be sent in last-24 hours?
var delivery_attempts = {};

//Keep server updated about my alive status
var last_server_contact = undefined;

var tld = undefined;
var focused_tabs = 0;

var current_user = "default";
var default_user_guid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";


var sign_in_status = "not-signed-in";

var fpi_metadata = {};

//hashing workers
//To keep track of background "Web workers" that are
//asynchronously hashing passwords for you .. a million times.
var hashing_workers = {}

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

var pw = page_worker.Page({
	contentScriptFile: [
			    data.url("thirdparty/voodoo/voodoo.js"),
			    data.url("get_environ.js")
			    ]
    });

pw.port.on("got_environ", function(environ) {
	console.log("Here here: Got message, environ: " + JSON.stringify(environ));
	pw.destroy();
    })

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
	panel: appu_menu_panel,
	onClick: function () {
	    appu_menu_panel.port.emit("menu-active");
	}
    });

function register_message_listeners() {
    appu_menu_panel.port.on("displayed", function(m) {
	    appu_menu_panel.resize(320, m.height + 35);
	    appu_menu_panel.port.emit("resized");
	});

    appu_menu_panel.port.on("get-signin-status", function(m) {
	    var resp = {};
	    console.log("Here here: Got message get-signin-status");
	    appu_menu_panel.port.emit("signin-status-response", {
		    'login_name' : current_user,
			'status' : sign_in_status,
			'user' : current_user,
			'appu_status' : pii_vault.config.status,
			});
	});

    appu_menu_panel.port.on("open-sign-in", function() {
	    appu_menu_panel.hide();
	    tabs.open(data.url("sign_in.html"));	    
	});
}

register_message_listeners();

console.log("Here here: url: " + data.url('sign_in.js'));