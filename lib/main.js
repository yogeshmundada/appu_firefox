"use strict";

var data = require("sdk/self").data;
var panel = require("sdk/panel");
var timers = require("sdk/timers");
var object = require("sdk/util/object");
var widget = require("sdk/widget");
var page_worker = require("sdk/page-worker");
var tabs = require("sdk/tabs");
var globals = require("./globals").global_var;

var test1 = require("./test1");
var test2 = require("./test2");

//console.log("Here here: globals.report_reminder_interval: " + JSON.stringify(globals));


var vault = require("./vault");
var update_stats = require("./update_stats");
var util = require("./util");


Object.size = function(obj) {
    var size = 0, key;
    for (key in obj) {
        if (obj.hasOwnProperty(key)) size++;
    }
    return size;
};

function toType(obj) {
  return ({}).toString.call(obj).match(/\s([a-zA-Z]+)/)[1].toLowerCase()
}

var CryptoJS = util.include_thirdparty("sha1.js").CryptoJS;
//console.log("Here here: Secret one-way: " + CryptoJS.SHA1('secret').toString());

var zxcvbn = require('./thirdparty/zxcvbn/zxcvbn.js').zxcvbn;
var tld = require('./thirdparty/tldjs/index.js');
var sprintf = require('./thirdparty/sprintf-0.7-beta1.js').sprintf;

//var sjcl = util.include_thirdparty("sjcl.js").sjcl;

var kk = sprintf("%s: testing", "mmorpg");
//console.log("Here here: in sprintf: " + JSON.stringify(kk));

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
	    console.log("Here here: XXXXXXXXXXXXXX Got message get-signin-status");
	    appu_menu_panel.port.emit("signin-status-response", {
		    'login_name' : current_user,
			'status' : sign_in_status,
			'user' : current_user,
			'appu_status' : pii_vault.config.status,
			});
	});

    appu_menu_panel.port.on("open-sign-in", function() {
	    appu_menu_panel.hide();
	    tabs.open({
		    url: data.url("sign_in.html"),
			onOpen: function(tab) {
		    },
			onReady: function(tab) {
			var sign_in_worker = tab.attach({
				contentScriptFile: [
						    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
						    data.url("sign_in.js"),
						    data.url("thirdparty/bootstrap/js/bootstrap.min.js"),
						    ]
			    });
			console.log("Here here: signinworker: " + JSON.stringify(Object.keys(sign_in_worker)));
			console.log("Here here: signinworker-url: " + this.url);

			sign_in_worker.port.on("get-version", function(args) {
				console.log("Here here: Got get-version");
				//Need to change following to read it from pii_vault.config.version
// 				sign_in_worker.port.emit("get-version-response", {
// 					"version" : manifest['version']
// 				    });
			    });

			sign_in_worker.port.on('get-signin-status', function(args) {
				console.log("Here here: Got get-signin-status");
				appu_menu_panel.port.emit("get-signin-status-response", {
					'login_name' : current_user,
					    'status' : sign_in_status,
					    'user' : current_user,
					    'appu_status' : pii_vault.config.status,
					    });

				//Need to change following to read it from pii_vault.config.version
// 				sign_in_worker.port.emit("get-version-response", {
// 					"version" : manifest['version']
// 				    });
			    });


		    }
		});	    
	});
}

register_message_listeners();

var manifest = data.load("manifest.json");
manifest = JSON.parse(manifest);


//console.log("Here here: version: " + manifest['version']);
//console.log("Here here: vault_read is : " + toType(vault.vault_read));

//console.log("Here here: site is : " + tld.getDomain('a.b.google.com'));

function init_environ() {
    //console.log("Here here: initing environ");
    var pw = page_worker.Page({
	    contentScriptFile: [
				data.url("thirdparty/voodoo1/voodoo.js"),
				data.url("get_environ.js")
				]
	});
    
    pw.port.on("got_environ", function(environ) {
	    var my_str = JSON.stringify(environ);
	    var my_test = {};
	    my_test = object.extend(my_test, environ);
	    //console.log("Here here: Testing extend: " + JSON.stringify(my_test));
	    globals.environ = environ;
	    //console.log("Here here: callback for pg worker, voodoo: " + JSON.stringify(globals.environ));
	    pw.destroy();

	    // BIG EXECUTION START
	    vault.vault_read();
	    vault.vault_init();
	})
}

init_environ();

// fpi_metadata_read();

//Detect if the version was updated.
//If updated, then do update specific code execution

//var ret_vals = make_version_check();
//var am_i_updated = ret_vals[0];
//var last_version = ret_vals[1];

// if (am_i_updated) {
//     //Make one time changes for upgrading from older releases.
//     update_specific_changes(last_version);
// }

//Call init. This will set properties that are newly added from release to release.
//Eventually, after the vault properties stabilise, call it only if vault property
//"initialized" is not set to true.
//vault.vault_init();


//timers.setTimeout(test1.setting_value, 1000);
//timers.setTimeout(test2.printing_value, 2000);

timers.setTimeout(vault.my_set_current_report, 1000);
timers.setTimeout(util.my_get_current_report, 2000);
