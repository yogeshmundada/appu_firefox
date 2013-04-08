var data = require("sdk/self").data;
var globals = require("./globals").global_var;

this_mod = (function (
		      pii_vault
		      ) {
		var mod_vars = {};

		function include_thirdparty(lib_name) {
		    const { Cc, Ci } = require("chrome");
    
		    var mozIJSSubScriptLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
		    .getService(Ci.mozIJSSubScriptLoader);

		    var lib_mod = {};
		    mozIJSSubScriptLoader.loadSubScript(data.url("thirdparty/" + lib_name), lib_mod);
		    return lib_mod;
		}


		function print_appu_error(err_str) {
		    if (err_str.indexOf("Appu Error: Could not process FPI template for:") == 0) {
			//No need to push that a template is not present again and again
			if (pii_vault.current_report.appu_errors.indexOf(err_str) == -1) {
			    pii_vault.current_report.appu_errors.push(err_str);
			}
		    }
		    else {
			console.log("Here here: ZZZZ in util, pii_vault: " + JSON.stringify(pii_vault));
			pii_vault.current_report.appu_errors.push(err_str);
		    }

		    console.log(err_str);
		    flush_selective_entries("current_report", ["appu_errors"]);
		}


		//Only useful for reading extension specific files
		function read_file(filename) {
		    var file_data = data.load(filename);
		    return file_data;
		}


		function read_file_arraybuffer(filename, onload_function) {
		    var url = data.url(filename);
		    var request = new XMLHttpRequest();
		    request.open("GET", url, true);
		    request.responseType = 'arraybuffer';

		    request.onload = function(req) {
			var r1 = req;
			return onload_function;
		    }(request);

		    request.onerror = function(oEvent) {
			print_appu_error("Appu Error: Reading file as arraybuffer: " 
					 + filename);
			console.log("APPU DEBUG: Reading file as arraybuffer:" + filename);
		    }

		    request.send();
		}


		function write_file(filename, data) {
		    var url = data.url(filename);
		    var request = new XMLHttpRequest();
		    request.open("PUT", url, true);

		    request.onerror = function(oEvent) {
			print_appu_error("Appu Error: Writing file: " 
					 + filename);
			console.log("APPU DEBUG: Writing file:" + filename);
		    }

		    request.send(data);
		}


		function generate_random_id() {
		    var guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
			    var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
			    return v.toString(16);
			});
		    return guid;
		}
		
		mod_vars.include_thirdparty = include_thirdparty;
		mod_vars.print_appu_error   = print_appu_error
		mod_vars.read_file	   = read_file
		mod_vars.write_file	   = write_file
		mod_vars.generate_random_id = generate_random_id

		return mod_vars;
	    }(
	      globals.pii_vault
	      ));

exports.include_thirdparty = this_mod.include_thirdparty;
exports.print_appu_error   = this_mod.print_appu_error;
exports.read_file	   = this_mod.read_file;
exports.write_file	   = this_mod.write_file;
exports.generate_random_id = this_mod.generate_random_id;

