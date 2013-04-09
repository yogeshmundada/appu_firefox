"use strict";

var timers = require("sdk/timers");
var globals = require("./globals").global_var;

var this_mod = (function (
			  test_value,
			  pii_vault
		      ) {
		var mod_vars = {};
		function printing_value() {
		    console.log("Here here: Printing test_value: " + JSON.stringify(test_value));
		    console.log("Here here: Printing test_value: " + JSON.stringify(pii_vault));
		}
		mod_vars.printing_value = printing_value;
		return mod_vars;
	    }
(
 globals.test_value,
  globals.pii_vault
));

exports.printing_value	        = this_mod.printing_value;

// timers.setTimeout(function() {
// 	console.log("Here here: Printing test_value: " + JSON.stringify(globals.test_value));
//     }, 2000);
