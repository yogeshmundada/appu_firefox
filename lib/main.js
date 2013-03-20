var data = require("sdk/self").data;
 
// Construct a panel, loading its content from the "text-entry.html"
// file in the "data" directory, and loading the "get-text.js" script
// into it.
var text_entry = require("sdk/panel").Panel({
	width: 420,
	height: 500,
	contentURL: data.url("popup.html"),
	contentScriptFile: [ 
			    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
			    data.url("thirdparty/bootstrap/js/bootstrap.min.js"),
			    data.url("popup.js"), 
			     ]
    });
 
// Create a widget, and attach the panel to it, so the panel is
// shown when the user clicks the widget.
require("sdk/widget").Widget({
	label: "Text entry",
	    id: "text-entry",
	    contentURL: data.url("images/appu_new.ico"),
	    panel: text_entry
	    });
