var data = require("sdk/self").data;
var panel = require("sdk/panel");
var widget = require("sdk/widget");

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
	id: "appu-menu",
	contentURL: data.url("images/appu_new.ico"),
	panel: appu_menu_panel
    });

appu_menu_panel.port.on("displayed", function(m) {
	console.log("YuHoo: Appu Menu has been displayed: height: " + m.height + ", width: " + m.width);
	appu_menu_panel.resize(m.width - 30, m.height + 35);
	appu_menu_panel.port.emit("resized");
	console.log("New panel height: " + appu_menu_panel.height + ", width: " + appu_menu_panel.width);
	console.log("New panel isShowing: " + appu_menu_panel.isShowing);
    });

console.log("Here here: Finishing main.js");