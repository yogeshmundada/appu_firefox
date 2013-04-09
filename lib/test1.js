"use strict";

var timers = require("sdk/timers");
var globals = require("./globals").global_var;

var this_mod = (function (
		      test_value
		      ) {
		var mod_vars = {};
		function setting_value() {
		    console.log("Here here: Setting test_value: ");
		    test_value.my_value = {
			"newval" : 999,
			"oldval" : 998,
		    }
		    test_value.options.kkk = {
			"ty" : 56,
		    };
		    
		}
		mod_vars.setting_value = setting_value;
		return mod_vars;
	    }
(
  globals.test_value
));

exports.setting_value	        = this_mod.setting_value;


// timers.setTimeout(function() {
// 	console.log("Here here: Setting the value of test_value");
// 	globals.test_value = {
// 	    "new_test" : 55,
// 	    "old_test" : 44,
// 	}
//     }, 1000)
