"use strict";

var data = require("sdk/self").data;
var panel = require("sdk/panel");
var timers = require("sdk/timers");
var object = require("sdk/util/object");
var widget = require("sdk/widget");
var page_worker = require("sdk/page-worker");
var tabs = require("sdk/tabs");
var request = require("sdk/request").Request;
var localStorage = require("sdk/simple-storage").storage;
var pageMod = require("sdk/page-mod");


var CryptoJS = include_thirdparty("sha1.js").CryptoJS;
var sjcl = include_thirdparty("sjcl.js").sjcl;

var zxcvbn = require('./thirdparty/zxcvbn/zxcvbn.js').zxcvbn;
var tld = require('./thirdparty/tldjs/index.js');
var sprintf = require('./thirdparty/sprintf-0.7-beta1.js').sprintf;


var ext_id = '';

var pii_vault = { "options" : {}, "config": {}};

var pending_warnings = {};
var pending_pi_fetch = {};

//If user says remind me later
var report_reminder_interval = 30;

//Report check interval in minutes
var report_check_interval = 5;

//Do background tasks like send undelivered reports;
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

var focused_tabs = 0;

var current_user = "default";
var default_user_guid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

var sign_in_status = "not-signed-in";

var fpi_metadata = {};

//hashing workers
//To keep track of background "Web workers" that are
//asynchronously hashing passwords for you .. a million times.
var hashing_workers = {};

var environ = {};

//List of page-mod workers for communicating.
//I've to maintain this due to bad design of Jetpack.
//Ideally, I should be able to get it from tabs object.
//But currently there is no way. However, a bug is already filed.
//Hopefully will get fixed in the next version of Jetpack SDK.
var workers = [];

// ************ START OF FPI Code ******************		

/// Template processing code START
// Creates a dictionary that has all PI fields mentioned in this template with
// information such as which one of them can be null and which ones are mandatory.
// Returns a tree of created template nodes.
function traverse_template_create_tree(fd, curr_node, site_pi_fields) {
    var all_kids = $(fd).children('div');
    var last_kid = null;

    curr_node.children = [];
    curr_node.xml_node = fd;
    curr_node.name = $(fd).attr('name');

    if (all_kids.length == 0) {
	//This is a leaf node .. represents actual value to be downloaded from the site
	var name = $(fd).attr('name');

	var can_be_a_null = $(fd).attr('can_be_a_null');
	site_pi_fields[name] = {};
	if (can_be_a_null != undefined) {
	    site_pi_fields[name].can_be_a_null = (can_be_a_null == 'no') ? false : true;
	}
	else {
	    site_pi_fields[name].can_be_a_null = true;
	}

	site_pi_fields[name].filled = false;
	site_pi_fields[name].processed = false;
	site_pi_fields[name].value = [];
    }
    else {
	for(var i = 0; i < all_kids.length; i++) {
	    var new_node = {};
	    new_node.parent = curr_node;
	    new_node.sibling_num = i;
	    new_node.completely_processed = false;
	    
	    if (last_kid != null) {
		new_node.left_sibling = last_kid;
		last_kid.right_sibling = new_node;
		new_node.right_sibling = null;
		last_kid = new_node;
	    }
	    else {
		new_node.left_sibling = null;
		last_kid = new_node;
	    }

	    curr_node.children.push(new_node);
	    if ($(all_kids[i]).attr('type')) {
		new_node.type = $(all_kids[i]).attr('type');
	    }

	    traverse_template_create_tree(all_kids[i], new_node, site_pi_fields);
	}
    }
}

function wait_on_sibling_processing_to_finish(curr_node, site_pi_fields, my_slave_tab, level) {
    var event_namespace = sprintf('.%s-%s-%s', my_slave_tab.tabid, level, curr_node.sibling_num);
    var event_name = "sibling-is-done" + event_namespace;

    console.log("APPU DEBUG: WAIT_ON_SIBLING_PROCESSING_TO_FINISH(), event: " + event_name + " sleeping on: " + 
		$(curr_node.parent.child_processing_div).attr('id') + ", my-name: " + curr_node.name);

    $('#' + $(curr_node.parent.child_processing_div).attr('id'))
	.on(event_name, { en : event_namespace} , function(event) {
	if (event.currentTarget.id == event.target.id) {
	    event.stopPropagation();
	    var event_namespace = event.data.en;
	    if (curr_node.parent.process_next_kid == true) {
		console.log("APPU DEBUG: WAIT_ON_SIBLING_PROCESSING_TO_FINISH(), woken up on: " + 
			    $(curr_node.parent.child_processing_div).attr('id') + ", my-name: " + curr_node.name);
		
		$('#' + $(curr_node.parent.child_processing_div).attr('id')).off("sibling-is-done" + 
										 event_namespace);

		curr_node.parent.process_next_kid = false;
		curr_node.process_next_kid = true;
		process_action(curr_node, $(curr_node.xml_node).children('action'), 
			       site_pi_fields, my_slave_tab, level);
	    }
	    else {
		console.log("APPU DEBUG: WAIT_ON_SIBLING_PROCESSING_TO_FINISH(), Again sleeping on: " + 
			    $(curr_node.parent.child_processing_div).attr('id') + ", my-name: " + curr_node.name);
	    }
	}
    });
}


//Instead of doing direct recursion, one has to do indirect one
//as JS has all the calls such as fetch URLs async.(to not annoy users waiting and blocking)
//and also because slave-tab is a resource that multiple nodes will want to use
//to fetch their URLs.
//This async business is making me insane...because of soooo much indirection.
//Can't wait to have "yield" in ECMAScript 6.
function traverse_and_fill(curr_node, site_pi_fields, my_slave_tab, level) {
    if (curr_node.parent == null) {
	console.log("APPU DEBUG: Creating root process_div");
	//This is the root node. So we should be good to process next kid.
	curr_node.process_next_kid = true;

	//Also create a <div> element and attach it to main body.
	//This will be used to indicate that the current child has been
	//processed upto its leaf node.
	//Current level(which will be 0) and since this node is root, child number = 0;
	var dummy_tab_id = sprintf('child-processing-complete-%s-%s-%s', my_slave_tab.tabid, level, "0");
	var dummy_div_str = sprintf('<div id="%s"></div>', dummy_tab_id);
	var dummy_div = $(dummy_div_str);
	$('body').append(dummy_div);
	curr_node.child_processing_div = dummy_div;

	console.log("APPU DEBUG: TRAVERSE_AND_FILL(), curr_node: " + curr_node.name + ", PROCEEDING (ROOT)");
	process_action(curr_node, $(curr_node.xml_node).children('action'), 
		       site_pi_fields, my_slave_tab, level);
    }
    else {
	//We are not root node.
	var dummy_tab_id = sprintf('child-processing-complete-%s-%s-%s',  my_slave_tab.tabid, 
				   level, curr_node.sibling_num);
	var dummy_div_str = sprintf('<div id="%s"></div>', dummy_tab_id);
	var dummy_div = $(dummy_div_str);
	$($(curr_node.parent.child_processing_div)).append(dummy_div);
	curr_node.child_processing_div = dummy_div;

	if (curr_node.parent.process_next_kid == true) {
	    curr_node.parent.process_next_kid = false;
	    curr_node.process_next_kid = true;
	    console.log("APPU DEBUG: TRAVERSE_AND_FILL(), curr_node: " + curr_node.name + ", PROCEEDING");
	    process_action(curr_node, $(curr_node.xml_node).children('action'), 
			   site_pi_fields, my_slave_tab, level);
	}
	else {
	    curr_node.process_next_kid = false;
	    console.log("APPU DEBUG: TRAVERSE_AND_FILL(), curr_node: " + curr_node.name + ", SLEEPING");
	    wait_on_sibling_processing_to_finish(curr_node, site_pi_fields, my_slave_tab, level);
	}
    }
}

function process_kids(curr_node, site_pi_fields, my_slave_tab, level) {
    for(var i = 0; i < curr_node.children.length; i++) {
	traverse_and_fill(curr_node.children[i], site_pi_fields, my_slave_tab, level+1);
    }
}

function send_cmd_to_tab(action_type, curr_node, site_pi_fields, fetch_url, my_slave_tab, level) {
    //Send message to my dedicated tab slave to fetch the url for me and
    //send back the HTML document.
    if (action_type == "fetch-url") {
	chrome.tabs.sendMessage(my_slave_tab.tabid, {
	    type: "goto-url", 
	    url: fetch_url
	}); 
	template_processing_tabs[my_slave_tab.tabid] = fetch_url;
    }
    else if (action_type == "simulate-click") {
	console.log("APPU DEBUG: In SIMULATE-CLICK, selector: " + curr_node.css_selector 
		    + ", filter: " + curr_node.css_filter);
	
	// Send first child node action as well to detect the change in the web page.
	var child_node_action = $(curr_node.children[0].xml_node).children('action');
	var child_node_action_css = $.trim($(child_node_action).text());

	chrome.tabs.sendMessage(my_slave_tab.tabid, {
	    type: "simulate-click", 
	    css_selector : curr_node.css_selector,
	    css_filter : curr_node.css_filter,
	    detect_change_css : child_node_action_css
	});

	template_processing_tabs[my_slave_tab.tabid] = "dummy-url";
    }
    else {
	print_appu_error("Appu Error: Unknow action for slave tab: " + action_type);
    }

    // console.log("APPU DEBUG: ZZZ tabid: " + my_slave_tab.tabid + ", value: " + 
    // 		template_processing_tabs[my_slave_tab.tabid]);


    //Now the tricky part. We want to know that the tab we just sent message to
    //has the document ready. For this, wait on a custom event on a dummy <div>.
    var dummy_tab_id = sprintf('tab-%s', my_slave_tab.tabid);
    
    $('#' + dummy_tab_id).on("page-is-loaded", function() {
	console.log("APPU DEBUG: Requesting for page-html");
	$('#' + dummy_tab_id).off("page-is-loaded");
	chrome.tabs.sendMessage(my_slave_tab.tabid, {
	    type: "get-html"
	}, function process_fetched_html(html_data) {
	    my_slave_tab.in_use = false;
	    
	    $('#wait-queue-tab-' + my_slave_tab.tabid).trigger("waiting_queue");
	    var fp = document.implementation.createHTMLDocument("fp");
	    
	    fp.documentElement.innerHTML = html_data;
	    curr_node.fp = fp;

	    process_kids(curr_node, site_pi_fields, my_slave_tab, level);
	}); 
    });
}

//Simulate a waiting queue. When someone calls to fetch url and if their slave tab is busy 
//fetching another url, then put that node on waiting queue.
//Waiting on the slave tab occurs in a situation where parent-node's link has been fetched
//and all children now want to fetch their links.
function make_slavetab_do_work(action_type, curr_node, site_pi_fields, fetch_url, my_slave_tab, level) {
    if (!('gatekeeper_initialized' in my_slave_tab)) {
	my_slave_tab.gatekeeper_initialized = true;
	my_slave_tab.wait_queue = [];
	var event_name = "waiting_queue";
	var wait_dummy_tab_id = sprintf('wait-queue-tab-%s', my_slave_tab.tabid);
	$('#' + wait_dummy_tab_id).on(event_name, function() {
	    console.log("APPU DEBUG: woken up from SLAVE-TAB waiting queue");
	    if (my_slave_tab.in_use == true) {
		console.log("APPU DEBUG: Woken up from wait queue but tab is in use");
	    }
	    else {
		if (my_slave_tab.wait_queue.length > 0) {
		    var t = my_slave_tab.wait_queue.pop();
		    my_slave_tab.in_use = true;
		    send_cmd_to_tab(t.action_type, t.curr_node, t.site_pi_fields, 
				       t.fetch_url, my_slave_tab, t.level);
		}
	    }
	});
    }

    if (my_slave_tab.in_use == true) {
	var t = {
	    'action_type' : action_type,
	    'curr_node' : curr_node,
	    'site_pi_fields' : site_pi_fields,
	    'fetch_url' : fetch_url,
	    'level' : level
	};
	my_slave_tab.wait_queue.push(t);
    }
    else {
	my_slave_tab.in_use = true;
	send_cmd_to_tab(action_type, curr_node, site_pi_fields, fetch_url, my_slave_tab, level);
    }
}

function process_action(curr_node, action, site_pi_fields, my_slave_tab, level) {
    //console.log("APPU DEBUG, Name: " + curr_node.name + ", action: " + $(action).attr('type'));

    if ($(action).attr('type') == 'fetch-url') {
	var fetch_url = $.trim($(action).text());
	//console.log('APPU DEBUG: Fetching :' + fetch_url);
	make_slavetab_do_work("fetch-url", curr_node, site_pi_fields, fetch_url, my_slave_tab, level);
    }
    else if ($(action).attr('type') == 'fetch-href') {
	var pfp = curr_node.parent.fp;
	var css_selector = $.trim($(action).text());
	var fetch_url = $.trim($(css_selector, pfp).attr('href'));
	console.log("APPU DEBUG: Got fetch-href: " + fetch_url);
	make_slavetab_do_work("fetch-url", curr_node, site_pi_fields, fetch_url, my_slave_tab, level);
    }
    else if ($(action).attr('type') == 'simulate-click') {
	var pfp = curr_node.parent.fp;
	var css_selector = $.trim($(action).text());
	var css_filter = $.trim($(action).attr('filter'));
	curr_node.css_selector = css_selector;
	curr_node.css_filter = css_filter;
	make_slavetab_do_work('simulate-click', curr_node, site_pi_fields, undefined, my_slave_tab, level);
    }
    else if ($(action).attr('type') == 'fetch-dom-element') {
	var pfp = curr_node.parent.fp;
	var css_selector = $.trim($(action).text());
	var css_filter = $.trim($(action).attr('filter'));

	curr_node.fp = apply_css_filter(apply_css_selector(pfp, css_selector), css_filter);
	process_kids(curr_node, site_pi_fields, my_slave_tab, level)
    }
    else if ($(action).attr('type') == 'store') {
	var pfp = curr_node.parent.fp;
	var css_selector = $.trim($(action).text());
	var store_data = [];
	var element;
	var css_filter = $.trim($(action).attr('filter'));
	
	var result = [];

 	var is_editable = $(action).attr('field_type');
 	if (is_editable != undefined) {
 		is_editable = (is_editable == 'editable') ? true : false;
 	} else{
 		is_editable = false;
 	}

	console.log("APPU DEBUG: In store");

	if (curr_node.parent.type && 
	    curr_node.parent.type == 'vector') {
	    $.each(pfp, function(index, e) {
		r = apply_css_filter(apply_css_selector(e, css_selector), css_filter);
		result.push(r);
	    });
	}
	else {
	    r = apply_css_filter(apply_css_selector(pfp, css_selector), css_filter);
	    result.push(r);
	}

	for(var i = 0; i < result.length; i++) {
	    var field_value = "";
 	    if(is_editable){
		field_value = $.trim($(result[i]).val());
 	    } 
	    else {
		field_value = $.trim($(result[i]).text());
 	    }

	    if (field_value != "") {
		store_data.push(field_value);
	    }
	}

	if (store_data.length > 0) {
	    console.log('APPU DEBUG: Storing data :' + JSON.stringify(store_data));
	    curr_node.result = store_data;
	    
	    site_pi_fields[curr_node.name].value = site_pi_fields[curr_node.name].value.concat(store_data);
	    site_pi_fields[curr_node.name].filled = true;
	    site_pi_fields[curr_node.name].processed = true;
	}

	inform_parent(curr_node);
    }
    else if ($(action).attr('type') == 'combine-n-store') {
	var pfp = curr_node.parent.fp;
	var css_selector = $.trim($(action).text());
	var store_data = [];
	var element;
	var css_filter = $.trim($(action).attr('filter'));
	
	var result = [];

 	var is_editable = $(action).attr('field_type');
 	if (is_editable != undefined) {
 		is_editable = (is_editable == 'editable') ? true : false;
 	} else{
 		is_editable = false;
 	}

	if (curr_node.parent.type && 
	    curr_node.parent.type == 'vector') {
	    $.each(pfp, function(index, e) {
		r = apply_css_filter(apply_css_selector(e, css_selector), css_filter);
		result.push(r);
	    });
	}
	else {
	    r = apply_css_filter(apply_css_selector(pfp, css_selector), css_filter);
	    result.push(r);
	}

	for(var i = 0; i < result.length; i++) {
	    var combined_value = "";

	    if ($(result[i]).length > 1) {
		$.each(result[i], function(index, value) { 
		    var field_value = "";
 		    if(is_editable){
			field_value = $.trim($(value).val());
 		    } 
		    else {
			field_value = $.trim($(value).text());
 		    }

		    if (field_value != "") {
			combined_value += field_value + ", " 
		    }
		});
		
		if (combined_value.length >= 2 && 
		    (combined_value.substring(combined_value.length - 2) == ", ")) {
		    combined_value = combined_value.substring(0, combined_value.length - 2);
		}
	    }
	    else {
		var field_value = "";
 		if(is_editable) {
		    field_value = $.trim($(result[i]).val());
 		} 
		else {
		    field_value = $.trim($(result[i]).text());
 		}

		if (field_value != "") {
		    combined_value = field_value;
		}
	    }

	    if (combined_value != "") {
		store_data.push(combined_value);
	    }
	}

	if (store_data.length > 0) {
	    console.log('APPU DEBUG: Storing data :' + JSON.stringify(store_data));
	    curr_node.result = store_data;
	    
	    site_pi_fields[curr_node.name].value = site_pi_fields[curr_node.name].value.concat(store_data);
	    site_pi_fields[curr_node.name].filled = true;
	    site_pi_fields[curr_node.name].processed = true;
	}

	inform_parent(curr_node);
    }
    else {
	print_appu_error("Appu Error: Unknow action in FPI template: " + $(action).attr('type'));
    }
}

function are_all_kids_processed(node) {
    var all_processed = true;
    for(var i = 0; i < node.children.length; i++) {
	if (node.children[i].completely_processed == false) {
	    all_processed = false;
	    break;
	}
    }
    return all_processed;
}

function fpi_processing_complete(tabid, site_pi_fields, domain, shut_timer) {
    var main_tab = sprintf("#tab-%s", tabid);
    var wait_queue_tab = sprintf("#wait-queue-tab-%s", tabid);
    var child_processing_tab = sprintf("#child-processing-complete-%s-0-0", tabid);
    var successfully_processed = true;
	
    for(var pi_name in site_pi_fields) {
	if (!site_pi_fields[pi_name].can_be_a_null) {
	    if (site_pi_fields[pi_name].value.length == 0) {
		print_appu_error("Appu Error: FPI failed due to PI: " + pi_name + ", domain: " + domain);
		successfully_processed = false;
		break;
	    }
	}
    }
    
    if (successfully_processed) {
	console.log("APPU DEBUG: SUCCESSFUL:: Identified all kids: " + 
		    JSON.stringify(site_pi_fields));

	store_per_site_pi_data(domain, site_pi_fields);
    }
    else {
	print_appu_error("Appu Error: Could not process FPI template for: " + domain);
    }
    
    if (shut_timer != undefined) {
	window.clearTimeout(shut_timer);
    }

    $(main_tab).remove();
    $(wait_queue_tab).remove();
    $(child_processing_tab).remove();
    delete template_processing_tabs[tabid];
    chrome.tabs.remove(tabid);
}

function inform_parent(leaf_node) {
    leaf_node.completely_processed = true;
    var curr_node = leaf_node;
    var all_processed = true;
    console.log("APPU DEBUG: INFORM_PARENT(), setting done for: " + curr_node.name);
    while(all_processed && curr_node.parent != null) {
	all_processed = are_all_kids_processed(curr_node.parent);
	if (all_processed) {
	    curr_node.parent.completely_processed = true;
	    curr_node = curr_node.parent;
	}
    }

    console.log("APPU DEBUG: INFORM_PARENT(), all_siblings_processed: " + all_processed + ", parent null?: " + 
		(curr_node.parent == null));

    if (all_processed && (curr_node.parent == null)) {
	//Satisfying above condition means that all nodes in FPI are processed and
	//curr node is ROOT.
	//So it will have all the attributes set at the beginning of process_template()
	console.log("APPU DEBUG: ROOT node is processed, time to close tab");
	fpi_processing_complete(curr_node.my_slave_tab.tabid,  curr_node.site_pi_fields, 
				curr_node.domain, curr_node.shut_timer);
    }
    else {
	//All of my subtree is processed...give a chance to sibling subtrees.
	curr_node.parent.process_next_kid = true;
	console.log("APPU DEBUG: INFORM_PARENT(), triggering sibling-is-done for: " + 
		    $(curr_node.parent.child_processing_div).attr('id') + ", my-name: " + curr_node.name);

	$('#' + $(curr_node.parent.child_processing_div).attr('id')).trigger("sibling-is-done");
    }
}

function apply_css_filter(elements, css_filter) {
    if (css_filter && css_filter != "") {
	return $(elements).filter(css_filter);
    }
    return elements;
}

function apply_css_selector(elements, css_selector) {
    if (css_selector && css_selector != "") {
	return $(css_selector, elements);
    }
    return elements;
}

function process_template(domain, data, my_slave_tab) {
    var fd = $.parseXML(data);
    var template_tree = {};
    var site_pi_fields = {};

    //Hard timeout..
    //Stop processing after 300 seconds.
    var shut_tab_forcefully = window.setTimeout(function() {
    	console.log("APPU DEBUG: In forceful shutdown for FPI of domain: " + domain);
	fpi_processing_complete(template_tree.my_slave_tab.tabid,  template_tree.site_pi_fields, 
				template_tree.domain, undefined);
    }, 300 * 1000);

    template_tree.shut_timer = shut_tab_forcefully;
    template_tree.parent = null;
    template_tree.name = 'root';
    template_tree.completely_processed = false;
    template_tree.domain = domain;
    template_tree.site_pi_fields = site_pi_fields;

    template_tree.my_slave_tab = my_slave_tab;

    level = 0;
    console.log("APPU DEBUG: PROCESS_TEMPLATE called");
    traverse_template_create_tree($(fd).children(), template_tree, site_pi_fields);

    traverse_and_fill(template_tree, site_pi_fields, my_slave_tab, level);
}

/// Template processing code END

function start_pi_download_process(domain, data) {
    var process_template_tabid = undefined;
    //Just some link so that appu content script runs on it.
    var default_url = 'http://google.com';
    
    //Create a new tab. Once its ready, send message to process the template.
    chrome.tabs.create({ url: default_url, active: false }, function(tab) {
	process_template_tabid = tab.id;
	var my_slave_tab = { tabid: process_template_tabid, 'in_use': true}
	template_processing_tabs[process_template_tabid] = default_url;
	//console.log("APPU DEBUG: XXX tabid: " + tab.id + ", value: " + 
	// template_processing_tabs[tab.id]);
	
	//Dummy element to wait for HTML fetch
	var dummy_tab_id = sprintf('tab-%s', process_template_tabid);
	var dummy_div_str = sprintf('<div id="%s"></div>', dummy_tab_id);
	var dummy_div = $(dummy_div_str);
	$('body').append(dummy_div);
	
	//Dummy element to wait for SLAVE tab to become free.
	var wait_dummy_tab_id = sprintf('wait-queue-tab-%s', process_template_tabid);
	var wait_dummy_div_str = sprintf('<div id="%s"></div>', wait_dummy_tab_id);
	var wait_dummy_div = $(wait_dummy_div_str);
	$('body').append(wait_dummy_div);
	
	$('#' + dummy_tab_id).on("page-is-loaded", function() {
	    my_slave_tab.in_use = false;
	    $('#' + dummy_tab_id).off("page-is-loaded");
	    process_template(domain, data, my_slave_tab);    
	});
    });
}

function check_if_pi_fetch_required(domain, sender_tab_id) {
    if (!(domain in pii_vault.aggregate_data.per_site_pi)) {
	pii_vault.aggregate_data.per_site_pi[domain] = {};
	flush_selective_entries("aggregate_data", ["per_site_pi"]);
    }

    var curr_time = new Date();
    
    if ('download_time' in pii_vault.aggregate_data.per_site_pi[domain]) {
	var last_update = new Date(pii_vault.aggregate_data.per_site_pi[domain].download_time);
	var td = curr_time.getTime() - last_update.getTime();
	if (td < (60 * 60 * 24 * 10 * 1000)) {
	    //This means that the PI was downloaded just 10 days ago.
	    //No need to download it just yet.
	    console.log("APPU DEBUG: Recently updated the PI, no need to update it for: " + domain);
	    return;
	}
    }
    
    //Following is a throttle on download attempts in a single day.
    if ('attempted_download_time' in pii_vault.aggregate_data.per_site_pi[domain]) {
	var last_download_attempt = new Date(pii_vault.aggregate_data.per_site_pi[domain]
					     .attempted_download_time);
	var td = curr_time.getTime() - last_download_attempt.getTime();
	//Check if its been 1 day since last download attempt
	if (td < (60 * 60 * 24 * 1 * 1000)) {
	    console.log("APPU DEBUG: Not attempting PI download. Just attempted so in last 24-hours: " + domain);
	    return;
	}
    }

    if ('user_approved' in pii_vault.aggregate_data.per_site_pi[domain]) {
	if (pii_vault.aggregate_data.per_site_pi[domain].user_approved == 'never') {
	    //Why go through all the pain of downloading FPI?
	    return;
	}
    }
    
    pii_vault.aggregate_data.per_site_pi[domain].attempted_download_time = new Date();
    flush_selective_entries("aggregate_data", ["per_site_pi"]);

    if ((domain in fpi_metadata) && 
	(fpi_metadata[domain]["fpi"] != "not-present")) {
	    var data = read_file("fpi/" + fpi_metadata[domain]["fpi"]);
	    console.log("APPU DEBUG: Read the template for: " + domain);
	    // We are here that means template is present.
	    // Attempt to fetch the PI if user has already approved it.
	    if ('user_approved' in pii_vault.aggregate_data.per_site_pi[domain]) {
		if (pii_vault.aggregate_data.per_site_pi[domain].user_approved == 'always') {
		    //We are here, that means user has given PI download approval for this site
		    start_pi_download_process(domain, data);
		    return;
		}
		else if (pii_vault.aggregate_data.per_site_pi[domain].user_approved == 'never') {
		    console.log("APPU DEBUG: User has already set NEVER for PI on this domain: " + domain);
		    return;
		}
	    }

	    //We are here, that means that we have to seek permission from user to download PI for
	    //this site.
	    chrome.tabs.sendMessage(sender_tab_id, {
		    'type' : "get-permission-to-fetch-pi",
			'site' : domain,
			}, function(response) {
		    if (response.fetch_pi_permission == "always") {
			pii_vault.aggregate_data.per_site_pi[domain].user_approved = 'always';
			flush_selective_entries("aggregate_data", ["per_site_pi"]);
			start_pi_download_process(domain, data);
		    }
		    else if (response.fetch_pi_permission == "just-this-time") {
			pii_vault.aggregate_data.per_site_pi[domain].user_approved = 'seek-permission';
			flush_selective_entries("aggregate_data", ["per_site_pi"]);
			start_pi_download_process(domain, data);
		    }
		    else if (response.fetch_pi_permission == "never") {
			pii_vault.aggregate_data.per_site_pi[domain].user_approved = 'never';
			flush_selective_entries("aggregate_data", ["per_site_pi"]);
			console.log("APPU DEBUG: User set NEVER for PI on this domain: " + domain);
		    }
		});
    }
    else {
	print_appu_error("Appu Error: FPI Template for domain(" + domain 
			 + ") is not present in the FPI list");
    }
    
    return;
}


//This is older code when FPI fetching occurred everytime form server.
//This code has been replaced now as FPIs are stored along with extension.
function fetch_fpi_template_from_server(domain) {
    wr = {};
    wr.command = 'get_template';
    wr.domain = domain;

    try {
	$.post("http://appu.gtnoise.net:5005/get_template", JSON.stringify(wr), function(data) {
	    pii_vault.aggregate_data.per_site_pi[domain].attempted_download_time = new Date();
	    flush_selective_entries("aggregate_data", ["per_site_pi"]);
	    
	    if (data.toString() != 'No template present') {
		console.log("APPU DEBUG: Got the template for: " + domain);
		// We are here that means template is present.
		// Attempt to fetch the PI if user has already approved it.
		if ('user_approved' in pii_vault.aggregate_data.per_site_pi[domain]) {
		    if (pii_vault.aggregate_data.per_site_pi[domain].user_approved == 'always') {
			//We are here, that means user has given PI download approval for this site
			start_pi_download_process(domain, data);
			return;
		    }
		    else if (pii_vault.aggregate_data.per_site_pi[domain].user_approved == 'never') {
			console.log("APPU DEBUG: User has already set NEVER for PI on this domain: " + domain);
			return;
			}
		}

		//We are here, that means that we have to seek permission from user to download PI for
		//this site.
		chrome.tabs.sendMessage(sender_tab_id, {
		    'type' : "get-permission-to-fetch-pi",
		    'site' : domain,
		}, function(response) {
		    if (response.fetch_pi_permission == "always") {
			pii_vault.aggregate_data.per_site_pi[domain].user_approved = 'always';
			flush_selective_entries("aggregate_data", ["per_site_pi"]);
			start_pi_download_process(domain, data);
		    }
		    else if (response.fetch_pi_permission == "just-this-time") {
			pii_vault.aggregate_data.per_site_pi[domain].user_approved = 'seek-permission';
			flush_selective_entries("aggregate_data", ["per_site_pi"]);
			start_pi_download_process(domain, data);
		    }
		    else if (response.fetch_pi_permission == "never") {
			pii_vault.aggregate_data.per_site_pi[domain].user_approved = 'never';
			flush_selective_entries("aggregate_data", ["per_site_pi"]);
			console.log("APPU DEBUG: User set NEVER for PI on this domain: " + domain);
		    }
		});
	    }
	    else {
		print_appu_error("Appu Error: FPI Template for domain(" + domain 
				 + ") is not present on the server");
	    }
	})
	.error(function(domain) {
		return function(data, status) {
		    print_appu_error("Appu Error: Service down, attempted to fetch template: " 
				     + domain + ", " + status.toString() + " @ " + (new Date()));
		   console.log("APPU DEBUG: Service down, attempted to fetch:" + domain);
		}
	    } (domain));
    }
    catch (e) {
	console.log("Error: while fetching template(" + domain + ") from server");
    }
}


function get_all_pi_data() {
    var r = {};
    for (var site in pii_vault.aggregate_data.per_site_pi) {
	for(var field in pii_vault.aggregate_data.per_site_pi[site]) {
	    if (field == 'download_time' ||
		field == 'attempted_download_time' ||
		field == 'user_approved') {
		continue;
	    }
	    var values = pii_vault.aggregate_data.per_site_pi[site][field].values;
	    if (!(field in r)) {
		r[field] = {};
	    }
	    for (var v = 0; v < values.length; v++) {
		if (!(values[v] in r[field])) {
		    r[field][values[v]] = "";
		}
		r[field][values[v]] += site + ", ";  
	    }
	}
    }
    return r;
}

//Per site PI downloaded (aggregate_data)
//Key: site name
//Values: time downloaded
// field_name --> field value
// {
//   'domain_name' : {
//                     'download_time' : 'xyz',
//                     'field_name_1' : {
//                                       'values' : [val1, val2, val3],
//                                       'change_type' : 'modified'/'added'/'deleted'/'no-change'
//                                    }
//                     'attempted_download_time' : 'xyz',
//                     'user_approved' : 'always/seek-permission/never' 
//                   }
// }
function store_per_site_pi_data(domain, site_pi_fields) {
    domain = tld.getDomain(domain);
    var downloaded_fields = [];
    var old_pi_values = (domain in pii_vault.aggregate_data.per_site_pi) ? 
	pii_vault.aggregate_data.per_site_pi[domain] : {};

    //Make it blank first.
    pii_vault.aggregate_data.per_site_pi[domain] = {};

    pii_vault.aggregate_data.per_site_pi[domain]['attempted_download_time'] = 
	old_pi_values['attempted_download_time'];
    pii_vault.aggregate_data.per_site_pi[domain]['user_approved'] =
	old_pi_values['user_approved'];

    var curr_site_pi = pii_vault.aggregate_data.per_site_pi[domain];

    for (var field in site_pi_fields) {
	if (site_pi_fields[field].value.length > 0) {
	    add_field_to_per_site_pi(domain, field, site_pi_fields[field].value);
	    if (field in old_pi_values) {
		if (curr_site_pi[field].values.sort().join(", ") == 
		    old_pi_values[field].values.sort().join(", ")) {
	    	    curr_site_pi[field].change_type = 'no-change';
		}
		else {
	    	    curr_site_pi[field].change_type = 'modified';
		}
	    }
	    else {
		curr_site_pi[field].change_type = 'added';
	    }
	}
    }

    curr_site_pi.download_time = new Date();

    for (var pi in old_pi_values) {
	if (!(pi in curr_site_pi) && (old_pi_values[pi].change_type != 'deleted')) {
	    curr_site_pi[pi] = { 
		'values' : undefined, 
		'change_type': 'deleted'
	    };
	}
    }

    console.log("APPU DEBUG: Current site pi: " + JSON.stringify(pii_vault.aggregate_data.per_site_pi[domain]));
    flush_selective_entries("aggregate_data", ["per_site_pi"]);

    for (field in curr_site_pi) {
	if (field == 'download_time' ||
	    field == 'attempted_download_time' ||
	    field == 'user_approved') {
	    continue;
	}

	var t = { 
	    'field': field, 
	    'change_type': curr_site_pi[field].change_type
	}
	if (curr_site_pi[field].values == undefined) {
	    t.num_values = 0;
	}
	else {
	    t.num_values = curr_site_pi[field].values.length;
	}
	downloaded_fields.push(t);
    }

    //Update current report
    pii_vault.current_report.downloaded_pi[domain] = {
	'download_time' : curr_site_pi.download_time,
	'downloaded_fields' : downloaded_fields,
    };
    
    //Aggregate by values on sites
    calculate_common_fields();
    flush_selective_entries("current_report", ["downloaded_pi"]);

    for (var i = 0; i < report_tab_ids.length; i++) {
	chrome.tabs.sendMessage(report_tab_ids[i], {
	    type: "report-table-change-row",
	    table_name: "downloaded_pi",
	    mod_type: "replace",
	    changed_row: [
		domain,
		curr_site_pi.download_time,
		downloaded_fields.map(function(o) { return o.field; }).join(", "),
	    ],
	});
    }
}

//This is supposed to consolidate common fields w/o revealing them.
//It takes care of multiple field values. For eg. if name on 3 sites is Joe
//and 2 others is John, it will create
//name1: ["site1", "site2", "site3"]
//name2: ["site4", "site5"]
function calculate_common_fields() {
    var r = get_all_pi_data();
    var vpfvi = pii_vault.aggregate_data.pi_field_value_identifiers;
    var common_fields = {};

    for (f in r) {
	for (v in r[f]) {
	    var value_identifier = undefined;
	    if (v in vpfvi) {
		value_identifier = vpfvi[v];
	    }
	    else {
		var j = 1;
		var identifier_array = Object.keys(vpfvi).map(function(key){
			return vpfvi[key];
		    });
		//Just to check that this identifier does not already exist.
		while(1) {
		    value_identifier = f + j;
		    if (identifier_array.indexOf(value_identifier) == -1) {
			break;
		    }
		    j++;
		}
		vpfvi[v] = value_identifier;
	    }
	    common_fields[value_identifier] = r[f][v].substring(0, r[f][v].length - 2 ).split(",");
	}
    }
 
    pii_vault.current_report.common_fields = common_fields;
    flush_selective_entries("current_report", ["common_fields"]);
    flush_selective_entries("aggregate_data", ["pi_field_value_identifiers"]);
}

function sanitize_phone(phones) {
    var ph_regex = /\(([0-9]{3})\) ([0-9]{3})-([0-9]{4})/;

    for (var i = 0; i < phones.length; i++) {
	if (ph_regex.exec(phones[i]) != null) {
	    phones[i] = phones[i].replace(ph_regex, "$1-$2-$3");
	}
    }
}

function sanitize_ccn(ccns) {
    var ccn_regex = /\*\*\*\*\*\*\*\*\*\*\*\*([0-9]{4})/;

    for (var i = 0; i < ccns.length; i++) {
	if (ccn_regex.exec(ccns[i]) != null) {
	    ccns[i] = ccns[i].replace(ccn_regex, "XXXX-XXXX-XXXX-$1");
	}
    }
}

function add_field_to_per_site_pi(domain, pi_name, pi_value) {
    pi_name = pi_name.toLowerCase();

    console.log("APPU DEBUG: adding to per_site_pi, domain: " + domain + ", name:" + pi_name + ", value:" 
		+ pi_value);

    if (pi_name == "phone") {
	sanitize_phone(pi_value);
    }
    if (pi_name == "ccn") {
	sanitize_ccn(pi_value);
    }

    //Nullify the previously existing value in case of
    //refetch after 'X' number of days.
    pii_vault.aggregate_data.per_site_pi[domain][pi_name] = {};
    pii_vault.aggregate_data.per_site_pi[domain][pi_name].values = [];

    var domain_pi = pii_vault.aggregate_data.per_site_pi[domain];
    //pi_value could be an array in case of a vector
    var new_arr = domain_pi[pi_name].values.concat(pi_value);

    //eliminate duplicates.
    //e.g. over time, if we fetch pi from same site,
    //(for additions like addresses/ccns) then 
    //remove duplicates.
    unique_new_arr = new_arr.filter(function(elem, pos) {
	return new_arr.indexOf(elem) == pos;
    })

    console.log("APPU DEBUG: Adding this data: " + unique_new_arr);
    domain_pi[pi_name].values = unique_new_arr;
    
    //delete empty entries.
    // if(domain_pi[pi_name].values.length == 0) {
    // 	delete domain_pi[pi_name].values;
    // } 
}

function fpi_metadata_read() {
    var fname = "fpi/fpi.json";
    var buff = read_file(fname);
    fpi_metadata = JSON.parse(buff);
}

// ************ END OF FPI Code ******************		

// ************ START OF Password Code ******************		

function calculate_pwd_similarity(grp_name) {
    var pwd_similarity = pii_vault.current_report.pwd_similarity;
    var pwd_groups = pii_vault.current_report.pwd_groups;
    var total_grps = 0;
    for (g in pwd_similarity) {
	pwd_similarity[g].push(0);
	total_grps++;
    }
    pwd_similarity[grp_name] = [];
    for (var i = 0; i < (total_grps+1); i++) {
	pwd_similarity[grp_name].push(0);
    }
    flush_selective_entries("current_report", ["pwd_similarity"]);

    for (var i = 0; i < report_tab_ids.length; i++) {
	chrome.tabs.sendMessage(report_tab_ids[i], {
	    type: "report-table-change-table",
	    table_name: "pwd_similarity",
	    pwd_similarity: pii_vault.current_report.pwd_similarity,
	    pwd_groups: pii_vault.current_report.pwd_groups,
	});
    }
}


//This function is supposed to generate group names such as 'A', 'B', .., 'AA', 'AB', 'AC' ..
function new_group_name(pwd_groups) {
    //Start at 'A'
    var init_group = 65;
    var new_name_detected = false;
    var new_name_arr = [];
    new_name_arr.push(init_group);

    while (!new_name_detected) {
	var char_new_name_arr = [];
	for (var i = 0; i < new_name_arr.length; i++) {
	    char_new_name_arr.push(String.fromCharCode(new_name_arr[i]));
	}
	var new_name = char_new_name_arr.reverse().join("");
	new_name_detected = !(('Grp ' + new_name) in pwd_groups);

	if (!new_name_detected) {
	    var array_adjusted = false;
	    while (!array_adjusted) {
		for (var j = 0; j < new_name_arr.length; j++) {
		    new_name_arr[j] += 1;
		    if (new_name_arr[j] <= 90) {
			array_adjusted = true;
			break;
		    }
		    else {
			new_name_arr[j] = 65;
		    }
		}
		if (!array_adjusted) {
		    new_name_arr.push(init_group);
		    array_adjusted = true;
		}
	    }//Adjust array infinite while
	}
	else {
	    return new_name;
	}
    }//Find new group name infinite while
}


//Remember, this pwd is iterated over a million times. 
//Not easy to crack
function get_pwd_group(domain, full_hash, password_strength) {
    var pwd_groups = pii_vault.aggregate_data.pwd_groups;
    var previous_group = false;
    var current_group = false;

    for (g in pwd_groups) {
	if (pwd_groups[g].sites.indexOf(domain) != -1) {
	    previous_group = g;
	}
	if (pwd_groups[g].full_hash == full_hash) {
	    current_group = g;
	}
    }

    if (previous_group && 
	pwd_groups[previous_group].full_hash != full_hash) {
	//This means password changed .. means group change .. first delete the domain from previous group
	pwd_groups[previous_group].sites.splice(pwd_groups[previous_group].sites.indexOf(domain), 1);
    }

    if (current_group) {
	//This means that there exists a group with exact same full hash
	if (pwd_groups[current_group].sites.indexOf(domain) == -1) {
	    //This means that even though the group exists, this domain is not part of it. So we will add it.
	    pwd_groups[current_group].sites.push(domain);
	}
    }
    else {
	// This means that we will have to create a new group and increase number of different
	// passwords by one.
	var new_grp = new_group_name(pwd_groups);
	new_grp = 'Grp ' + new_grp;
	pwd_groups[new_grp] = {};
	pwd_groups[new_grp].sites = [domain];
	pwd_groups[new_grp].strength = password_strength;
	pwd_groups[new_grp].full_hash = full_hash;
	    
	pii_vault.aggregate_data.num_pwds += 1;

	flush_selective_entries("aggregate_data", ["num_pwds", "pwd_groups"]);
	current_group = new_grp;
    }

    // Now do similar things for current_report
    var cr_pwd_groups = pii_vault.current_report.pwd_groups;
    var cr_previous_group = false;
    // First find if domain is already present in any of the groups
    for (g in cr_pwd_groups) {
	if (cr_pwd_groups[g].sites.indexOf(domain) != -1) {
	    cr_previous_group = g;
	    break;
	}
    }

    if (cr_previous_group) {
	//This means that domain was seen earlier in this report period
	if (cr_previous_group != current_group) {
	    // This means that password has changed groups, so first delete it from previous group
	    cr_pwd_groups[cr_previous_group].sites.splice(cr_pwd_groups[cr_previous_group].sites.indexOf(domain), 1);
	    send_pwd_group_row_to_reports('replace', cr_previous_group, cr_pwd_groups[cr_previous_group].sites, 
					  cr_pwd_groups[cr_previous_group].strength);
	}
    }

    //Also add the domain to current_group
    if (current_group in cr_pwd_groups) {
	if (cr_pwd_groups[current_group].sites.indexOf(domain) == -1) {
	    cr_pwd_groups[current_group].sites.push(domain);
	}
    }
    else {
	//Create a new group and add this entry to the list
	cr_pwd_groups[current_group] = {};
	cr_pwd_groups[current_group].sites = object.extend([], pwd_groups[current_group].sites);
	cr_pwd_groups[current_group].strength = password_strength;
	
	pii_vault.current_report.num_pwds += 1;
	flush_selective_entries("current_report", ["num_pwds"]);
	send_pwd_group_row_to_reports('add', current_group, cr_pwd_groups[current_group].sites, 
				      cr_pwd_groups[current_group].strength);
	calculate_pwd_similarity(current_group);
    }
    
    flush_selective_entries("current_report", ["pwd_groups"]);
    return current_group;
}


function get_pwd_unchanged_duration(domain) {
    try {
	var hk = '' + ':' + domain;
	if (hk in pii_vault.password_hashes) {
	    return (new Date() - new Date(pii_vault.password_hashes[hk].initialized));
	}
	return 0;
    }
    catch (e) {
	print_appu_error("Appu Error: Got an exception: " + e.message);
    }
    return 0;
}


//Calculates entire sha256 hash of the password.
//iterates over the hashing 1,000,000 times so that
//its really really hard for an attacker to crack it.
//Some back-of-the-envelope calculations for cracking a password 
//using the same cluster used in arstechnica article (goo.gl/BYi7M)
//shows that cracking time would be about ~200 days using brute force.
function calculate_full_hash(domain, username, pwd, pwd_strength) {
    var hw_key = domain + "_" + username;
    if (hw_key in hashing_workers) {
	console.log("APPU DEBUG: Cancelling previous active hash calculation worker for: " + hw_key);
	hashing_workers[hw_key].terminate();
	delete hashing_workers[hw_key];
    }

    var hw = new Worker('hash.js');
    hashing_workers[hw_key] = hw;

    hw.onmessage = function(worker_key, my_domain, my_username, my_pwd, my_pwd_strength) {
	return function(event) {
	    var rc = event.data;
	    var hk = my_username + ':' + my_domain;

	    if (typeof rc == "string") {
		console.log("(" + worker_key + ")Hashing worker: " + rc);
	    }
	    else if (rc.status == "success") {
		console.log("(" + worker_key + ")Hashing worker, count:" + rc.count + ", passwd: " 
			    + rc.hashed_pwd + ", time: " + rc.time + "s");
		if (pii_vault.password_hashes[hk].pwd_full_hash != rc.hashed_pwd) {
		    pii_vault.password_hashes[hk].pwd_full_hash = rc.hashed_pwd;

		    //Now calculate the pwd_group
		    var curr_pwd_group = get_pwd_group(my_domain, rc.hashed_pwd, [
										  my_pwd_strength.entropy, 
										  my_pwd_strength.crack_time,
										  my_pwd_strength.crack_time_display
										  ]);
		    
		    if (curr_pwd_group != pii_vault.current_report.user_account_sites[domain].my_pwd_group) {
			pii_vault.current_report.user_account_sites[domain].my_pwd_group = curr_pwd_group;
			flush_selective_entries("current_report", ["user_account_sites"]);
		    }
		    
		    //Now verify that short hash is not colliding with other existing short hashes.
		    //if so, then modify it by changing salt
		    for (var hash_key in pii_vault.password_hashes) {
			if (hash_key != hk && 
			    (pii_vault.password_hashes[hk].pwd_short_hash == 
			     pii_vault.password_hashes[hash_key].pwd_short_hash) &&
			    (pii_vault.password_hashes[hk].pwd_full_hash != 
			     pii_vault.password_hashes[hash_key].pwd_full_hash)) {
			    //This means that there is a short_hash collision. In this case, just change it,
			    //by changing salt
			    var err_msg = "Seems like short_hash collision for keys: " + hk + ", " + hash_key;
			    console.log("APPU DEBUG: " + err_msg);
			    print_appu_error("Appu Error: " + err_msg);
			    rc = calculate_new_short_hash(my_pwd, pii_vault.password_hashes[hk].salt);

			    pii_vault.password_hashes[hk].pwd_short_hash = rc.short_hash;
			    pii_vault.password_hashes[hk].salt = rc.salt;
			}
		    }
		    //Done with everything? Now flush those damn hashed passwords to the disk
		    vault_write("password_hashes", pii_vault.password_hashes);
		    send_user_account_site_row_to_reports(domain);
		}
		//Now delete the entry from web workers.
		delete hashing_workers[worker_key];
	    }
	    else {
		console.log("(" + worker_key + ")Hashing worker said : " + rc.reason);
	    }
	}
    } (hw_key, domain, username, pwd, pwd_strength);
 
    //First calculate the salt
    //This salt is only for the purpose of defeating rainbow attack
    //For each password, the salt value will always be the same as salt table is
    //precomputed and fixed
    var k = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(pwd));
    var r = k.substring(k.length - 10, k.length);
    var rsv = parseInt(r, 16) % 1000;
    var rand_salt = pii_vault.salt_table[rsv];
    var salted_pwd = rand_salt + ":" + pwd;

    console.log("APPU DEBUG: (calculate_full_hash) Added salt: " + rand_salt + " to domain: " + domain);

    hw.postMessage({
	        'limit' : 1000000,
		'cmd' : 'hash',
		'pwd' : salted_pwd,
		});
}


//First gets a different salt from the last value.
//Then, Calculates the super short hashsum
//Only count last 12-bits..so plenty of collisions for an attacker
function calculate_new_short_hash(pwd, prev_salt) {
    //First get a salt that is not equal to prev_salt
    var curr_salt = prev_salt;
    while (curr_salt == prev_salt) {
	var r = Math.floor((Math.random() * 1000)) % 1000;
	curr_salt = pii_vault.salt_table[r];
    }

    //Now get the short hash using salt calculated
    var salted_pwd = curr_salt + ":" + pwd;
    var k = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(salted_pwd));
    var hash_pwd = k.substring(k.length - 3, k.length);
    var rc = {
	'salt' : curr_salt,
	'short_hash' : hash_pwd, 
    }
    return rc;
}


//Calculates the super short hashsum given a salt
//Only count last 12-bits..so plenty of collisions for an attacker
function calculate_short_hash(pwd, salt) {
    //Now get the short hash using salt calculated
    var salted_pwd = salt + ":" + pwd;
    var k = sjcl.codec.hex.fromBits(sjcl.hash.sha256.hash(salted_pwd));
    var hash_pwd = k.substring(k.length - 3, k.length);
    rc = {
	'short_hash' : hash_pwd, 
    }
    return rc;
}


function vault_update_domain_passwd(domain, username, passwd, pwd_strength, is_stored) {
    var vpwh = pii_vault.password_hashes;
    var vcr = pii_vault.current_report;

    var hk = '' + ':' + domain;
    var salt; 
    var recalculate_hashes = false;
    update_user_account_sites_stats(domain, is_stored);       

    if (hk in vpwh) {
	salt = vpwh[hk].salt;
	var rc = calculate_short_hash(passwd, salt);
	if (rc.short_hash != vpwh[hk].pwd_short_hash) {
	    //This could mean that the passwords are changed
	    recalculate_hashes = true;
	}
	else {
	    if (vcr.user_account_sites[domain].my_pwd_group == "no group") {
		//This means that this is the first time we are logging in to this site
		//during this report's duration.
		//However, we have logged into this site in previous reports.
		var curr_pwd_group = get_pwd_group(domain, vpwh[hk].pwd_full_hash, [
										    pwd_strength.entropy, 
										    pwd_strength.crack_time,
										    pwd_strength.crack_time_display
										    ]);
		
		vcr.user_account_sites[domain].my_pwd_group = curr_pwd_group;
		flush_selective_entries("current_report", ["user_account_sites"]);
	    }
	}
    }
    else {
	recalculate_hashes = true;
    }
    
    if (recalculate_hashes == true) {
	rc = calculate_new_short_hash(passwd, '');
	
	console.log("APPU DEBUG: (calculate_new_short_hash) Added salt: " + rc.salt + " to domain: " + domain);
	
	vpwh[hk] = {};
	vpwh[hk].pwd_short_hash = rc.short_hash;
	vpwh[hk].pwd_full_hash = '';
	vpwh[hk].salt = rc.salt;
	vpwh[hk].initialized = new Date();
	//Now calculate sha256 by iterating a million times
	calculate_full_hash(domain, '', passwd, pwd_strength);
    }
    
    vault_write("password_hashes", vpwh);
    vcr.user_account_sites[domain].pwd_unchanged_duration =
	new Date() - new Date(vpwh[hk].initialized);
    flush_selective_entries("current_report", ["user_account_sites"]);
    
    send_user_account_site_row_to_reports(domain);
}


function pii_check_passwd_reuse(message, sender) {
    var r = {};
    // Why the f'k am I using os when there is r.sites?? Need to do cleanup.
    var os = [];
    r.is_password_reused = "no";
    r.already_exists = "no";
    r.initialized = 'Not sure';
    r.sites = [];
    var curr_username = '';
    var hk = curr_username + ':' + message.domain;

    var pwd_strength = zxcvbn(message.passwd);
    r.pwd_strength = pwd_strength;

    for(var hk in pii_vault.password_hashes) {
	var curr_entry = pii_vault.password_hashes[hk];
	var rc = calculate_short_hash(message.passwd, curr_entry.salt);
	if (curr_entry.pwd_short_hash == rc.short_hash) {
	    if (hk.split(":")[1] != message.domain || hk.split(":")[0] != curr_username) {
		r.is_password_reused = "yes";
		r.dontbugme = "no";
		r.sites.push(hk.split(":")[1]);
		os.push(hk.split(":")[1]);
		break;
	    }
	}
    }

    if (hk in pii_vault.password_hashes) {
	var curr_entry = pii_vault.password_hashes[hk];
	var rc = calculate_short_hash(message.passwd, curr_entry.salt);
	if (rc.short_hash == pii_vault.password_hashes[hk].pwd_short_hash) {
	    r.initialized = pii_vault.password_hashes[hk].initialized;
	}
    }

    if (r.is_password_reused == "yes") {
	if (message.warn_later) {
	    console.log("APPU INFO: Warn Later: " + message.domain);
	    r.dontbugme = "yes";
	}
	else {
	    for(var dbl in pii_vault.options.dontbuglist) {
		// console.log("DONTBUGME: Checking: "+ pii_vault.options.dontbuglist[dbl] 
		//    +" against: " + message.domain);
		if (pii_vault.options.dontbuglist[dbl] == message.domain) {
		    console.log("APPU INFO: Site in dontbuglist: " + message.domain);
		    r.dontbugme = "yes";
		    break;
		}
	    }
	}
    }

    if(r.is_password_reused == "no") {
	var user_log = sprintf("APPU INFO: [%s]: Checked password for '%s', NO match was found", 
			       new Date(), message.domain);
	console.log(user_log);
    }
    else {
	var user_log = sprintf("APPU INFO: [%s]: Checked password for '%s', MATCH was found: ", 
			       new Date(), message.domain);
	user_log += "{ " + os.join(", ") + " }";
	console.log(user_log);
    }

    if(r.is_password_reused == "yes") {
	var total_entries = pii_vault.current_report.pwd_reuse_warnings.length;
	var last_index =  total_entries ? pii_vault.current_report.pwd_reuse_warnings[total_entries - 1][0] : 0; 
	var new_row = [
	    last_index + 1, 
	    (new Date()).getTime(), 
	    message.domain,
	    os.join(", ")
	];

	pii_vault.current_report.pwd_reuse_warnings.push(new_row);
	flush_selective_entries("current_report", ["pwd_reuse_warnings"]);

	send_messages_to_report_tabs("report-table-change-row", {
		type: "report-table-change-row",
		table_name: "pwd_reuse_warnings",
		mod_type: "add",
		changed_row: new_row,
	    });
    }

    // This is so that if there is next successful sign-in message,
    // trigger a check_pi_fetched_required()
    // This is more fullproof than waiting X amount of time as login may
    // be unsuccessful in that case.
    // However, most fullproof method is per-site login check.
    pending_pi_fetch[sender.tab.id] = message.domain;
    return r;
}


function pii_check_pending_warning(message, sender) {
    var r = {};
    r.pending = "no";

    console.log("APPU DEBUG: (pii_check_pending_warning) Checking for pending warnings");
    if( pending_warnings[sender.tab.id] != undefined) {
	var p = pending_warnings[sender.tab.id];
	r.warnings = p.pending_warnings;
	vault_update_domain_passwd(p.domain, p.username, p.passwd, p.pwd_strength, p.is_stored);
	pending_warnings[sender.tab.id] = undefined;
	r.pending = "yes";
    }
    return r;
}


function does_user_have_account(domain) {
    for(var hk in pii_vault.password_hashes) {
	if (hk.split(":")[1] == domain) {
	    return true;
	}
    }
    return false;
}
// ************ END OF Password Code ******************		


// ************ START OF Blacklist Code ******************		
function pii_add_blacklisted_sites(message) {
    var dnt_site = message.dnt_site;
    var r = {};
    if (pii_vault.options.blacklist.indexOf(dnt_site) == -1) {
	pii_vault.options.blacklist.push(dnt_site);
	r.new_entry = dnt_site;
    }
    else {
	r.new_entry = null;
    }
    console.log("New blacklist: " + pii_vault.options.blacklist);
    vault_write("options:blacklist", pii_vault.options.blacklist);
    return r;
}


function pii_check_blacklisted_sites(message) {
    var r = {};
    r.blacklisted = "no";
    //console.log("Checking blacklist for site: " + message.domain);
    for (var i = 0; i < pii_vault.options.blacklist.length; i++) {
	var protocol_matched = "yes";
	var port_matched = "yes";
	var bl_url = pii_vault.options.blacklist[i];
	//Split URLs, simplifying assumption that protocol is only HTTP.
	var url_parts = bl_url.split('/');
	var bl_hostname = "";
	var bl_protocol = "";
	var bl_port = "";

	bl_hostname = ((url_parts[0].toLowerCase() == 'http:' || 
			url_parts[0].toLowerCase() == 'https:')) ? url_parts[2] : url_parts[0];
	bl_protocol = ((url_parts[0].toLowerCase() == 'http:' || 
			url_parts[0].toLowerCase() == 'https:')) ? url_parts[0].toLowerCase() : undefined;
	bl_port = (bl_hostname.split(':')[1] == undefined) ? undefined : bl_hostname.split(':')[1];

	var curr_url_parts = message.domain.split('/');
	var curr_hostname = "";
	var curr_protocol = "";
	var curr_port = "";

	curr_hostname = ((curr_url_parts[0].toLowerCase() == 'http:' || 
			  curr_url_parts[0].toLowerCase() == 'https:')) ? curr_url_parts[2] : curr_url_parts[0];
	curr_protocol = ((curr_url_parts[0].toLowerCase() == 'http:' || 
			  curr_url_parts[0].toLowerCase() == 'https:')) ? curr_url_parts[0].toLowerCase() : '';

	curr_port = (curr_hostname.split(':')[1] == undefined) ? '' : curr_hostname.split(':')[1];

	rev_bl_hostname = bl_hostname.split("").reverse().join("");
	rev_curr_hostname = curr_hostname.split("").reverse().join("");

	if (bl_protocol && (curr_protocol != bl_protocol)) {
	    protocol_matched = "no";
	} 

	if (bl_port && (curr_port != bl_port)) {
	    port_matched = "no";
	} 

	//First part of IF checks if the current URL under check is a 
	//subdomain of blacklist domain.
	if ((rev_curr_hostname.indexOf(rev_bl_hostname) == 0) && 
	    protocol_matched == "yes" && port_matched == "yes") {
	    r.blacklisted = "yes";
	    console.log("Site is blacklisted: " + message.domain);
	    break;
	}
    }
    return r;
}


function pii_get_blacklisted_sites(message) {
    var r = [];
    for (var i = 0; i < pii_vault.options.blacklist.length; i++) {
	r.push(pii_vault.options.blacklist[i]);
    }
    return r;
}


function pii_delete_dnt_list_entry(message) {
    pii_vault.options.blacklist.splice(message.dnt_entry, 1);
    vault_write("options:blacklist", pii_vault.options.blacklist);
}
// ************ END OF Blacklist Code ******************		


// ************ START OF Misc Code ******************		
//Function to see if Appu server is up  
//Also tells the server that this appu installation is still running

function pii_check_if_stats_server_up() {
    var stats_server_url = "http://woodland.gtnoise.net:5005/"
	try {
	    var wr = {};
	    wr.guid = (sign_in_status == 'signed-in') ? pii_vault.guid : '';
	    wr.version = pii_vault.config.current_version;
	    wr.deviceid = (sign_in_status == 'signed-in') ? pii_vault.config.deviceid : 'Not-reported';

	    var r = request({
		    url: stats_server_url,
		    content: JSON.stringify(wr),
		    onComplete: function(response) {
			if (response.status == 200) {
			    var data = response.text;
			    var is_up = false;
			    var stats_message = /Hey ((?:[0-9]{1,3}\.){3}[0-9]{1,3}), Appu Stats Server is UP!/;
			    is_up = (stats_message.exec(data) != null);
			    my_log("Appu stats server, is_up? : "+ is_up, new Error);
			}
			else {
			    //This means that HTTP response is other than 200 or OK
			    my_log("Appu: Could not check if server is up: " + stats_server_url
					+ ", status: " + response.status.toString(), new Error);
			    print_appu_error("Appu Error: Seems like server was down. " +
					     "Status: " + response.status.toString() + " "
					     + (new Date()));
			}
		    }
		});

	    r.post();
	}
	catch (e) {
	    my_log("Error while checking if stats server is up", new Error);
	}
    last_server_contact = new Date();
}


function pii_modify_status(message) {
    if (message.status == "enable") {
	timers.clearInterval(pii_vault.config.enable_timer);
	pii_vault.config.status = "active";
	pii_vault.config.disable_period = -1;
	flush_selective_entries("config", ["enable_timer", "status", "disable_period"]);

	appu_menu_widget.contentURL = data.url("images/appu_new19.png");

	for(var i = 0; i < workers.length; i++) {
	    workers[i].port.emit("status-enabled", {type: "status-enabled"});
	}
    }
    else if (message.status == "disable") {
	pii_vault.config.status = "disabled";
	pii_vault.config.disable_period = message.minutes;
	pii_vault.config.disable_start = (new Date()).toString();
	pii_vault.config.enable_timer = timers.setInterval(start_time_loop, 1000);
	flush_selective_entries("config", ["disable_start", "enable_timer", "status", "disable_period"]);

	pii_vault.current_report.appu_disabled.push(message.minutes);
	flush_selective_entries("current_report", ["appu_disabled"]);

	appu_menu_widget.contentURL = data.url("images/appu_new19_offline.png");

	my_log((new Date()) + ": Disabling Appu for " + message.minutes + " minutes", new Error);

	for(var i = 0; i < workers.length; i++) {
	    my_log("Here here: Sending message 'status-disabled' to tab: " + workers[i].tab.id, new Error);
	    workers[i].port.emit("status-disabled", {type: "status-disabled"});
	}
    }
}


function background_tasks() {
    //report = pii_vault.past_reports[report_number - 2];
    for (var i = 0; i < pii_vault.past_reports.length; i++) {
	var cr = pii_vault.past_reports[i];
	if (cr.actual_report_send_time == 'Not delivered yet') {
	    //To adjust for current_report(=1) and start index (0 instead of 1)
	    var report_number = i + 2;
	    my_log("APPU DEBUG: Report " + report_number + " is undelivered", new Error);
	    if (report_number in delivery_attempts) {
		var dat = delivery_attempts[report_number];
		var curr_time = new Date();
		var td = curr_time.getTime() - dat.getTime();	    
		if (td < (60 * 60 * 24 * 1000)) {
		    //Less than 24-hours, Skip
		    // 		    my_log("APPU DEBUG: Report " + report_number + 
		    // " was already attempted to " +
		    // 				"be delivered, so skipping");
		    continue;
		}
	    }
	    delivery_attempts[report_number] = new Date();
	    //	    my_log("APPU DEBUG: Attempting to send report " + report_number);
	    pii_send_report(report_number);   
	}
    }
    
    //If its been 24 hours, since we talked to server, just send a quick "I am alive" 
    //message
    var curr_time = new Date();
    var td = curr_time.getTime() - last_server_contact.getTime();	    
    if (td > (60 * 60 * 24 * 1000)) {
	pii_check_if_stats_server_up();
    }
}


function start_time_loop() {
    var curr_time = new Date();
    if ((curr_time - (new Date(pii_vault.config.disable_start))) > 
	(60 * 1000 * pii_vault.config.disable_period)) {
	timers.clearInterval(pii_vault.config.enable_timer);
	pii_vault.config.status = "active";
	pii_vault.config.disable_period = -1;
	flush_selective_entries("config", ["enable_timer", "status", "disable_period"]);

	appu_menu_widget.contentURL = data.url("images/appu_new19.png");

	for(var i = 0; i < workers.length; i++) {
	    workers[i].port.emit("status-enabled", {type: "status-enabled"});
	}

	my_log((new Date()) + ": Enabling Appu", new Error);
    } 
}

// ************ END OF Misc Code ******************		


// ************ START OF Update-Stats Code ******************		
function init_user_account_sites_entry() {
    var uas_entry = {};
    uas_entry.num_logins = 0;
    uas_entry.pwd_unchanged_duration = 0;
    uas_entry.pwd_stored_in_browser = 'donno';
    uas_entry.num_logouts = 0;
    uas_entry.latest_login = 0;
    //Specifically naming it with prefix "my_" because it was
    //creating confusion with current_report.pwd_groups (Notice 's' at the end)
    uas_entry.my_pwd_group = 'no group';
    uas_entry.tts = 0;
    uas_entry.tts_login = 0;
    uas_entry.tts_logout = 0;
    uas_entry.site_category = 'unclassified';
    return uas_entry;
}

function init_non_user_account_sites_entry() {
    var non_uas_entry = {};
    non_uas_entry.latest_access = 0;
    non_uas_entry.tts = 0;
    non_uas_entry.site_category = 'unclassified';
    return non_uas_entry;
}

function initialize_report() {
    var current_report = {};

    //Current report initialized
    current_report.initialize_time = new Date();

    //Current report: Id
    current_report.reportid = pii_vault.config.reportid;

    //Current report: Device Id
    current_report.deviceid = pii_vault.config.deviceid;

    //Current report: is it modified?
    current_report.report_modified = "no";
    //Current report: GUID
    current_report.guid = pii_vault.guid;
    current_report.num_report_visits = 0;
    current_report.report_time_spent = 0;

    //Errors generated during this reporting period.
    //Send them out for fixing
    current_report.appu_errors = [];

    //Has user viewed "My Footprint" page since
    //last report? Shows general curiosity and tech savvyness on behalf of 
    //user. Also tells us how engaging appu is.
    current_report.num_myfootprint_visits = 0;
    current_report.myfootprint_time_spent = 0;

    //Current report: was it reviewed?
    //Necessary because even if report sending is set to auto, a person
    //still might do review.
    current_report.report_reviewed = false;

    //Current report - Has user 'explicitly' approved it to be sent out?
    //This is either "false" or the timestamp of user approval.
    //In case report_setting is manual, then it is equal to scheduled_reporting_time.
    current_report.user_approved = false;

    // ** Following entry is totally experimental and most likely would be
    //    DEPRECATED in the future releases **
    //Sites where users have been entering inputs.
    //Its only use is for Appu to detect the kind of
    //inputs that users have been entering and where.
    //Also, if the input type is TEXT or similar, then length of the data 
    //entered
    //Each entry is of the form:
    // [1, new Date(1354966002000), 'www.abc.com', 'test', 'button', 'length'],
    // Very first entry is the unique record number useful for deletion.
    // Second is timestamp
    // Third name of the site
    // Fourth name of the input field
    // Fifth type of the input field - text, textarea, button etc
    // Sixth length of the input field
    current_report.input_fields = [];

    //Current report - How many attempts it took to send the report 
    //                 to the server? 
    // (This could be because either stats servers were down OR
    //  user was not connected to the Internet)
    current_report.send_attempts = [];

    //Current report - What was the extension version at the time of
    //                 this report?
    current_report.extension_version = pii_vault.config.current_version;

    //Current report - Was there a version update event in between?
    current_report.extension_updated = false;

    //Current report - Is the report structure updated?
    //This is useful so that if user has opened REPORTS page,
    //he will get dynamic 'aggregate' updates every 5 minutes.
    //Table row updates are sent asynchronously whenever they happen
    current_report.report_updated = false;

    //Scheduled time for this report
    current_report.scheduled_report_time = pii_next_report_time();
    //Actual send report time for this report
    current_report.actual_report_send_time = 'Not delivered yet';

    //"auto", "manual" or "differential"
    current_report.report_setting = pii_vault.options.report_setting;

    //How many times did user hit "remind me later" for this report?
    current_report.send_report_postponed = 0;
    //Total unique sites accessed since the last report
    //But don't actually enlist those sites
    current_report.num_total_sites = 0;
    //Total time spent on each site
    current_report.total_time_spent = 0;
    current_report.total_time_spent_logged_in = 0;
    current_report.total_time_spent_wo_logged_in = 0;

    //Sites with user's account that users have logged into
    //since last report
    current_report.num_user_account_sites = 0;

    //Each site is a record such as
    // site_name --> Primary Key
    // tts = Total Time Spent
    // tts_login = Total Time Spent Logged In
    // tts_logout = Total Time Spent Logged out
    // num_logins = Number of times logged in to a site
    // num_logouts = Number of times logged out of a site explicitly
    // latest_login = Last login time in the account
    // pwd_group = To group by sites using same password
    // site_category = Type of the site
    // A function init_user_account_sites_entry() gives the empty value for each site
    current_report.user_account_sites = {};

    //Sites where user does not have account (but "log in" is present)
    //Once again don't enlist those sites
    current_report.num_non_user_account_sites = 0;

    //Number of times appu was disabled. 
    //and how long each time
    current_report.appu_disabled = [];

    //New list of sites added to dontbuglist since last report
    current_report.dontbuglist = [];

    //Number of different passwords used since the last report
    current_report.num_pwds = 0;

    // Password group name, sites in each group and password strength
    // Key: "Grp A" etc
    // Value: {
    //    'sites' : Array of domains,
    //    'strength' : Array of pwd strength,
    // }
    // Since this field gets sent to the server, I don't store full_pwd_hash here.
    // That value is stored in aggregate_data.pwd_groups
    current_report.pwd_groups = {};

    //Similarity distance between each different password
    //Each entry is like {"pwd_group_0" : [{ "pwd_group_1" : 23}, { "pwd_group_2" : 14}]} 
    current_report.pwd_similarity = {};

    //Downloaded PI from following sites
    //Each entry is like: {'site_name' : { download_time: xyz, downloaded_fields: [a, b, c]}}
    current_report.downloaded_pi = {};

    //Fields that share common values across sites
    //Each entry is like: {'field_name' : ['site_1', 'site_2', 'site_3']} etc 
    //One has to consult aggregate stats for this.
    current_report.common_fields = {};

    //Finally our old pwd_reuse_warnings
    //Each record is of the following form:
    //[1, 1355555522298, 'aaa.com', 'bbb.com, ggg.com'],
    // First entry is the unique identifier to delete the record.
    // Second is timestamp
    // Third is site where user was warned on
    // Fourth is list of sites for which user was warned
    current_report.pwd_reuse_warnings = [];

    my_log("Here here: environ is: " + JSON.stringify(environ), new Error);
    //my_log("Here here: NEW environ is: " + JSON.stringify(environ));
    //General info about user's environment
    current_report.browser = environ.browser.name;
    current_report.browser_version = environ.browser.version;
    current_report.os = environ.platform.name;                      
    current_report.os_version = environ.platform.version;                                    
    current_report.layout_engine = environ.browser.engine;
    current_report.layout_engine_version = environ.browser.engineVersion;

    return current_report
	}

//Aggregate data is gathered over the time unlike daily reports.
//Also aggregate data will contain sensitive data such as per_site_pi
//that is not sent to the server. Only user can view it from "My Footprint"
function initialize_aggregate_data() {
    var aggregate_data = {};

    //When was this created?
    aggregate_data.initialized_time = new Date();
    //Is user aware? How many times is he reviewing his own data?
    //This could be used as a feedback to the system about user's awareness
    //(hence an indirect metric about users' savviness) and
    //also to warn user.
    aggregate_data.num_viewed = 0;
    aggregate_data.total_time_spent = 0;

    //Stats about general sites access
    aggregate_data.num_total_sites = 0;
    aggregate_data.all_sites_total_time_spent = 0;
    aggregate_data.all_sites_stats_start = new Date();

    //Stats and data about sites with user accounts (i.e. where user logs in)
    //user_account_sites[] is an associative array with key: site_name

    //Value corresponding to that is an object with following dictionary:
    //Each site is a record such as
    // site_name --> Primary Key
    // tts = Total Time Spent
    // tts_login = Total Time Spent Logged In
    // tts_logout = Total Time Spent Logged out
    // num_logins = Number of times logged in to a site
    // num_logouts = Number of times logged out of a site explicitly
    // latest_login = Last login time in the account
    // pwd_group = To group by sites using same password
    // site_category = Type of the site
    aggregate_data.num_user_account_sites = 0;
    aggregate_data.user_account_sites = {};

    //Stats and data about sites where user browses but never logs in
    //IMPORTANT: This detailed list of sites is only maintained in aggregate stats.
    //           Its never reported to the server.
    //non_user_account_sites[] is an associative array with key: site_name
    //Value corresponding to that is an object with following dictionary:
    //site_name, last_access_time, total_time_spent, site_category
    aggregate_data.num_non_user_account_sites = 0;
    aggregate_data.non_user_account_sites = {};
    
    //Passwords data
    //pwd_groups is an associative array. Key is group name and values are list of sites
    //sharing that password
    aggregate_data.num_pwds = 0;

    // Password group name, sites in each group and password strength
    // Key: "Grp A" etc
    // Value: {
    //    'sites' : Array of domains,
    //    'strength' : Array of pwd strength,
    //    'full_hash' : A million times rotated hash value of salted passwd,
    // }
    aggregate_data.pwd_groups = {};
    aggregate_data.pwd_similarity = {};

    //Per site PI downloaded
    //Key: site name
    //Values: time downloaded
    // field_name --> field value
    aggregate_data.per_site_pi = {};
    
    //This is used to assign a unique identifier to
    //each possible value of PI.
    //For eg. an address like "122, 5th ST SE, ATLANTA 30318, GA, USA" will
    //get an identifier like "address1"
    //Or a name like "Appu Singh" will get an identifier like "name3"
    //This is useful to show in reports page (so that the real values are
    // shown in the tooltip). Also it helps to always assign a unique 
    //identifier even if that thing is downloaded multiple times over the
    //time.
    aggregate_data.pi_field_value_identifiers = {};

    return aggregate_data;
}

function add_domain_to_uas(domain) {
    var cr = pii_vault.current_report;
    var ad = pii_vault.aggregate_data;
    var site_category = 'unclassified';

    if (domain in fpi_metadata) {
	site_category = fpi_metadata[domain]["category"];
    }

    if (!(domain in cr.user_account_sites)) {
	cr.user_account_sites[domain] = init_user_account_sites_entry();
	cr.user_account_sites[domain].site_category = site_category;
	cr.num_user_account_sites += 1;
	flush_selective_entries("current_report", ["user_account_sites", "num_user_account_sites"]);

	if (pii_vault.total_site_list.indexOf(domain) != -1 && 
	    !(does_user_have_account(domain))) {
	    // This means that this site was counted as non user account site before.
	    // So adjust it.
	    cr.num_non_user_account_sites -= 1;
	    flush_selective_entries("current_report", ["num_non_user_account_sites"]);
	}
    }

    //Add this site to aggregate data
    if (!(domain in ad.user_account_sites)) {
	ad.user_account_sites[domain] = init_user_account_sites_entry();
	ad.user_account_sites[domain].site_category = site_category;
	ad.num_user_account_sites += 1;

	flush_selective_entries("aggregate_data", ["num_user_account_sites", "user_account_sites"]);
    }
}


function update_user_account_sites_stats(domain, is_stored) {
    var cr = pii_vault.current_report;
    var ad = pii_vault.aggregate_data;

    //Add this site to current report, aggregate data if already not present
    add_domain_to_uas(domain);

    cr.user_account_sites[domain].num_logins += 1;
    cr.user_account_sites[domain].latest_login = new Date();

    ad.user_account_sites[domain].num_logins += 1;
    ad.user_account_sites[domain].latest_login = new Date();

    if (is_stored) {
	cr.user_account_sites[domain].pwd_stored_in_browser = 'yes';
    }
    else {
	cr.user_account_sites[domain].pwd_stored_in_browser = 'no';
    }

    flush_selective_entries("current_report", ["user_account_sites"]);
    flush_selective_entries("aggregate_data", ["user_account_sites"]);
}


function update_ad_non_uas(domain) {
    if (!(does_user_have_account(domain))) {
	pii_vault.current_report.num_non_user_account_sites += 1;
	flush_selective_entries("current_report", ["num_non_user_account_sites"]);
	if (!(domain in pii_vault.aggregate_data.non_user_account_sites)) {
	    pii_vault.aggregate_data.num_non_user_account_sites += 1;
	    pii_vault.aggregate_data.non_user_account_sites[domain] = 
		init_non_user_account_sites_entry();
	    flush_selective_entries("aggregate_data", [
						       "num_non_user_account_sites", 
						       "non_user_account_sites"
						       ]);
	}
	pii_vault.aggregate_data.non_user_account_sites[domain].latest_access = new Date();
	flush_selective_entries("aggregate_data", ["non_user_account_sites"]);
    }
}


function update_ad_non_uas_time_spent(domain, time_spent) {
    if (!(does_user_have_account(domain)) && 
	(domain in pii_vault.aggregate_data.non_user_account_sites)) {
	pii_vault.aggregate_data.non_user_account_sites[domain].tts += time_spent;
	flush_selective_entries("aggregate_data", ["non_user_account_sites"]);
    }
}

function send_messages_to_report_tabs(message, message_content) {
    for(var i = 0; i < workers.length; i++) {
	for (var j = 0; i < report_tab_ids.length; j++) {
	    if (workers[i].tab.id == report_tab_ids[j]) {
		workers[i].port.emit(message, message_content);

	    }
	}
    }
}

// current_report.input_fields = [
// 	[1, new Date(1354966002000), 'www.abc.com', 'test', 'button', 0],
function pii_log_user_input_type(message) {
    var total_entries = pii_vault.current_report.input_fields.length;
    var last_index =  total_entries ? pii_vault.current_report.input_fields[total_entries - 1][0] : 0; 
    var domain_input_elements = [
				 last_index + 1,
				 new Date(), 
				 tld.getDomain(message.domain), 
				 message.attr_list.name,
				 message.attr_list.type,
				 message.attr_list.length,
				 ];
    my_log("APPU INFO: Appending to input_fields list: " + JSON.stringify(domain_input_elements), new Error);
    pii_vault.current_report.input_fields.push(domain_input_elements);
    flush_selective_entries("current_report", ["input_fields"]);

    send_messages_to_report_tabs("report-table-change-row", {
			type: "report-table-change-row",
			    table_name: "input_fields",
			    mod_type: "add",
			    changed_row: domain_input_elements,
			    });
}

// ************ END OF Update-Stats Code ******************

// ************ START OF Reporting Code ******************
function pii_next_report_time() {
    var curr_time = new Date();

    curr_time.setSeconds(0);
    // Set next send time after 3 days
    curr_time.setMinutes( curr_time.getMinutes() + 4320);
    curr_time.setMinutes(0);
    curr_time.setHours(0);
    curr_time.setMinutes( curr_time.getMinutes() + pii_vault.config.reporting_hour);
    return new Date(curr_time.toString());
}


function open_reports_tab() {
    tabs.open({
	    url: data.url("report.html"),
		onOpen: function(tab) {
	    },
		onReady: function(tab) {
		var report_worker = tab.attach({
			contentScriptFile: [
					    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
					    data.url("thirdparty/bootstrap/js/bootstrap.min.js"),
					    data.url("thirdparty/DataTables-1.9.4/media/js/jquery.dataTables.js"),
					    data.url("thirdparty/DataTables-1.9.4/media/js/paging.js"),
					    data.url("report_utility.js"),
					    data.url("report.js"),
					    ]
		    });
		
		report_tab_ids.push(tab.id);
	    }
	});

    close_report_reminder_message();
}


function close_report_reminder_message() {
    for(var i = 0; i < workers.length; i++) {
	workers[i].port.emit("close-report-reminder", {type: "close-report-reminder"});
    }
}


function report_reminder_later(message) {
    var curr_time = new Date();
    curr_time.setMinutes(curr_time.getMinutes() + report_reminder_interval);

    pii_vault.config.report_reminder_time = curr_time.toString();
    flush_selective_entries("config", ["report_reminder_time"]);
    pii_vault.current_report.send_report_postponed += 1;
    flush_selective_entries("current_report", ["send_report_postponed"]);

    my_log(sprintf("[%s]: Report Reminder time postponed for: %dm", new Date(), report_reminder_interval), new Error);

    close_report_reminder_message();
}


function check_report_time() {
    var curr_time = new Date();
    var is_report_different = true;

    //Find out if any entries from current report differ from past reports
    if (pii_vault.options.report_setting == "differential") {
	if(curr_time.getTime() > (new Date(pii_vault.current_report.scheduled_report_time)).getTime()) {

	    // for (var i = 0; i < pii_vault.report.length; i++) {
	    // 	var rc = pii_check_if_entry_exists_in_past_pwd_reports(pii_vault.report[i]);
	    // 	if (rc == false) {
	    // 	    is_report_different = true;
	    // 	    break;
	    // 	}
	    // }

	    if (!is_report_different) {
		for (var i = 0; i < pii_vault.master_profile_list.length; i++) {
		    var rc = pii_check_if_entry_exists_in_past_profile_list(pii_vault.master_profile_list[i]);
		    if (rc == false) {
			is_report_different = true;
			break;
		    }
		}
	    }
	}
    }

    //First check that user has signed into Appu
    if (sign_in_status != 'not-signed-in') {
	//Make all the following checks only if reporting type is "manual"
	if (pii_vault.options.report_setting == "manual" || 
	    (pii_vault.options.report_setting == "differential" && is_report_different)) {
	    if (pii_vault.config.report_reminder_time == -1) {
		//Don't want to annoy user with reporting dialog if we are disabled OR
		//if user already has a review report window open (presumably working on it).
		if (pii_vault.config.status == "active" && is_report_tab_open == 0) {
		    if(curr_time.getTime() > (new Date(pii_vault.current_report.scheduled_report_time)).getTime()) {
			//Send message to all the tabs that report is ready for review and sending
			chrome.tabs.query({}, function(all_tabs) {
				for(var i = 0; i < all_tabs.length; i++) {
				    chrome.tabs.sendMessage(all_tabs[i].id, {type: "report-reminder"});
				}
			    });
		    }
		}
	    }
	    else if (curr_time.getTime() > (new Date(pii_vault.config.report_reminder_time)).getTime()) {
		my_log(sprintf("[%s]: Enabling Report Reminder", new Date()), new Error);
		pii_vault.config.report_reminder_time = -1;
		flush_selective_entries("config", ["report_reminder_time"]);
	    }
	}
	else if (pii_vault.options.report_setting == "auto" || 
		 (pii_vault.options.report_setting == "differential" && !is_report_different)) {
	    if(curr_time.getTime() > (new Date(pii_vault.current_report.scheduled_report_time)).getTime()) {
		//'1' for current report
		schedule_report_for_sending(1);
	    }
	}
    }
}


function schedule_report_for_sending(report_number) {
    //Store the approval timestamp in report.user_approved
    pii_vault.current_report.user_approved = new Date();
    flush_selective_entries("current_report", ["user_approved"]);
    pii_send_report(report_number);
}


function pii_send_report(report_number) {
    var report = undefined;
    if (report_number == 1) {
	report = pii_vault.current_report;
    }
    else {
	//Adjust by 2 as current_report's number is 1
	report = pii_vault.past_reports[report_number - 2];
    }
    var wr = {};
    wr.type = "periodic_report";

    //This is a temporary bug fix
    report.scheduled_report_time = new Date(report.scheduled_report_time);

    wr.current_report = report;

    try {
	$.post("http://woodland.gtnoise.net:5005/post_report", JSON.stringify(wr), 
	       function(report, report_number) {
		   return function(data, status) {
		       var is_processed = false;
		       stats_message = /Report processed successfully/;
		       is_processed = (stats_message.exec(data) != null);

		       if (is_processed) {
			   // Report successfully sent. Update the actual send time.
			   report.actual_report_send_time = new Date();
			   my_log("APPU INFO: Report '" + report_number 
				       + "'  is successfully sent to the server at: " 
				       + report.actual_report_send_time, new Error);
			   vault_write("past_reports", pii_vault.past_reports);
			   if (report_number in delivery_attempts) {
			       delete delivery_attempts[report_number];
			   }
		       }
		   };
	       }(report, report_number))
	    .error(function(report, report_number) {
		    return function(data, status) {
			print_appu_error("Appu Error: Error while posting 'periodic report' to the server: " 
					 + (new Date()));
			report.send_attempts.push(new Date());
			vault_write("past_reports", pii_vault.past_reports);
		    }
		}(report, report_number));
    }
    catch (e) {
	print_appu_error("Appu Error: Error while posting 'periodic report' to the server: " + (new Date()));
	report.send_attempts(push(new Date()));
	vault_write("past_reports", pii_vault.past_reports);
    }

    if (report_number == 1) {
	pii_vault.current_report.report_updated = false;
	pii_vault.past_reports.unshift(pii_vault.current_report);
	if (pii_vault.past_reports.length > 10) {
	    pii_vault.past_reports.pop();
	}

	pii_vault.config.reportid += 1;

	initialize_current_report();

	pii_vault.total_site_list = [];
	vault_write("total_site_list", pii_vault.total_site_list);
	vault_write("past_reports", pii_vault.past_reports);

	my_log("APPU INFO: Current report is added to past reports. " +
		    "New current report is created with reporting time: " 
		    + pii_vault.current_report.scheduled_report_time, new Error);

    }

    my_log("APPU INFO: Report '" + report_number + "'  is scheduled for sending.", new Error);
}


function initialize_current_report() {
    pii_vault.config.next_reporting_time = pii_next_report_time();
    flush_selective_entries("config", ["reportid", "next_reporting_time"]);

    pii_vault.current_report = initialize_report();
    flush_current_report();
}


function purge_report_entry(report_number, table_name, entry_key) {
    var report = undefined;
    var is_it_current_report = true;
    if (report_number == 1) {
	//This is current report
	report = pii_vault.current_report;
    }
    else {
	//Adjust index for past reports.
	//Report number 1 is current report.
	//So in the past reports, report number 2 is at index '0'
	report_number -= 2;
	report = pii_vault.past_reports[report_number];
	is_it_current_report = false;
    }

    if (report.actual_report_send_time == "Not delivered yet") {
	report.report_modified = "yes";
    }

    var report_table = report[table_name];
    if (report_table instanceof Array) {
	for(var i = 0; i < report_table.length; i++) {
	    if (report_table[i][0] == entry_key) {
		report_table.splice(i, 1);
		break;
	    }
	}
    }
    else {
	delete report_table[entry_key];
    }

    //Flush to disk
    if (is_it_current_report) {
	flush_selective_entries("current_report", ["report_modified", table_name]);
    }
    else {
	vault_write("past_reports", pii_vault.past_reports);
    }
}


function pii_get_differential_report(message) {
    var r = {};
    return r;
    //Need to fix this one.
    r.pwd_reuse_report = [];
    r.master_profile_list = [];
    r.scheduled_report_time = pii_vault.config.next_reporting_time;

    for (var i = 0; i < pii_vault.master_profile_list.length; i++) {
	var copied_entry = {};
	copied_entry.site_name = pii_vault.master_profile_list[i];

	if (!pii_check_if_entry_exists_in_past_profile_list(pii_vault.master_profile_list[i])) {
	    copied_entry.index = i;
	    r.master_profile_list.push(copied_entry);
	}
    }

    return r;
}


//Probably deprecated..also f'king big names..what was I thinking?
function pii_check_if_entry_exists_in_past_profile_list(curr_entry) {
    for(var i=0; i < pii_vault.past_reports.length; i++) {
	var past_master_profile_list = pii_vault.past_reports[i].master_profile_list;
	for(var j = 0; j < past_master_profile_list.length; j++) {
	    if (past_master_profile_list[j] == curr_entry) {
		return true;
	    }
	}
    }
    return false;
}


//Probably deprecated..also f'king big names..what was I thinking?
function pii_check_if_entry_exists_in_past_pwd_reports(curr_entry) {
    var ce = {};
    var ce_str = "";
    ce.site = curr_entry.site;
    ce.other_sites = curr_entry.other_sites;

    ce.other_sites.sort();
    ce_str = JSON.stringify(ce);

    for(var i=0; i < pii_vault.past_reports.length; i++) {
	var past_report = pii_vault.past_reports[i].pwd_reuse_report;
	for(var j = 0; j < past_report.length; j++) {
	    var past_report_entry = {};
	    var pre_str = "";
	    past_report_entry.site = past_report[j].site;
	    past_report_entry.other_sites = past_report[j].other_sites;
	    past_report_entry.other_sites.sort();
	    pre_str = JSON.stringify(past_report_entry);
	    if (pre_str == ce_str) {
		return true;
	    }
	}
    }
    return false;
}


function pii_get_report_by_number(report_number) {
    var response_report = undefined;
    var original_report = undefined;
    if ( report_number == 1) {
	original_report = pii_vault.current_report;

    }
    else {
	original_report = pii_vault.past_reports[report_number - 2];
    }

    response_report = object.extend({}, original_report);
    return [response_report, original_report];
}


//---------------------------------------------------------------------------
//Following functions are not really managing current report.
//Rather they update the displayed current_report on any tab if user is viewing it.


function send_pwd_group_row_to_reports(type, grp_name, sites, strength) {
    for (var i = 0; i < report_tab_ids.length; i++) {
	chrome.tabs.sendMessage(report_tab_ids[i], {
		type: "report-table-change-row",
		    table_name: "pwd_groups",
		    mod_type: type,
		    changed_row: [
				  grp_name,
				  sites.sort().join(", "),
				  strength.join(", "),
				  strength.join(", "),
				  ],
		    });
    }
}


function send_user_account_site_row_to_reports(site_name) {
    var uas_entry = pii_vault.current_report.user_account_sites[site_name];
    send_messages_to_report_tabs("report-table-change-row", {
	    type: "report-table-change-row",
		table_name: "user_account_sites",
		mod_type: "replace",
		changed_row: [
			      site_name,
			      uas_entry.pwd_unchanged_duration,
			      uas_entry.pwd_stored_in_browser,
			      uas_entry.my_pwd_group,
			      uas_entry.num_logins,
			      uas_entry.tts,
			      uas_entry.latest_login,
			      uas_entry.tts_login,
			      uas_entry.tts_logout,
			      uas_entry.num_logouts,
			      uas_entry.site_category
			      ],
		});
}
// ************ END OF Reporting Code ******************

// ************ START OF Util Code ******************

function my_log(msg, error) {
    var ln = error.lineNumber;
    var fn = error.fileName.split('->').slice(-1)[0].split('/').splice(-1)[0];
    console.log(fn + "," + ln + ": " + msg);
}

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
	pii_vault.current_report.appu_errors.push(err_str);
    }

    my_log(err_str, new Error);
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
	my_log("APPU DEBUG: Reading file as arraybuffer:" + filename, new Error);
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
	my_log("APPU DEBUG: Writing file:" + filename, new Error);
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
		
// ************ END OF Util Code ******************

// ************ START OF Sign-in Code ******************
function create_account(sender_worker, username, password) {
    var new_guid = generate_random_id();
    var wr = { 
	'guid': new_guid, 
	'username': CryptoJS.SHA1(username).toString(), 
	'password' : CryptoJS.SHA1(password).toString(),
	'version' : pii_vault.config.current_version 
    }

    var r = request({
	    url: "http://woodland.gtnoise.net:5005/create_new_account",
	    content: JSON.stringify(wr),
	    onComplete: function(response) {
		my_log("Here here: Comepleted create-account response", new Error);
		my_log("Here here: Response status: " + response.status, new Error);
		my_log("Here here: Response status txt: " + response.statusText, new Error);
		my_log("Here here: Response text: " + response.text, new Error);
		my_log("Here here: Response json: " + response.json, new Error);
		my_log("Here here: Response headers: " + response.headers, new Error);

		if (response.status == 200) {
		    var data = response.text;
		    if (data == 'Success') {
			sender_worker.port.emit("account-success",  {
				type: "account-success", 
				    desc: "Account was created successfully. You are now logged-in"
				    });

			//Reset pii_vault.
			pii_vault = { "options" : {}, "config": {}};
			pii_vault.guid = new_guid;
			my_log("create_account(): Updated GUID in vault: " + pii_vault.guid, new Error);
			vault_write("guid", pii_vault.guid);
			
			current_user = username;
			pii_vault.current_user = username;
			vault_write("current_user", pii_vault.current_user);
			
			sign_in_status = 'signed-in';
			pii_vault.sign_in_status =  'signed-in';
			vault_write("sign_in_status", pii_vault.sign_in_status);
			//GUID has changed, call init() to create new fields. Otherwise it
			//will not do anything.
			vault_init();
			my_log("APPU DEBUG: Account creation was success", new Error);
			//Just to report our status
			pii_check_if_stats_server_up();
		    }
		    else if (data.split(' ')[0] == 'Failed') {
			var temp = data.split(' ');
			temp.shift();
			var reason = temp.join(' ');

			sender_worker.port.emit("account-failure",  {
				type: "account-failure", 
				    desc: reason
				    });
			my_log("APPU DEBUG: Account creation was failure: " + reason, new Error);
		    }
		    else {
			sender_worker.port.emit("account-failure",  {
				type: "account-failure", 
				    desc: "Account creation failed for unknown reasons"
				    });
			my_log("APPU DEBUG: Account creation was failure: Unknown Reason", new Error);
		    }
		}
		else {
		    //This means that HTTP response is other than 200 or OK
		    print_appu_error("Appu Error: Account creation failed at the server: " 
				     + response.toString() + " @ " + (new Date()));

		    sender_worker.port.emit("account-failure",  {
			    type: "account-failure", 
				desc: "Account creation failed, service possibly down"
				});
		    my_log("APPU DEBUG: Account creation was failure: Unknown Reason", new Error);
		}
	    }
	});

    r.post();
}

function sign_in(sender_worker, username, password) {
    //zero out pii_vault first if guid is differnt
    var wr = { 
	'guid': pii_vault.guid, 
	'username': CryptoJS.SHA1(username).toString(), 
	'password' : CryptoJS.SHA1(password).toString(),
	'version' : pii_vault.config.current_version
    }

    var r = request({
	    url: "http://woodland.gtnoise.net:5005/sign_in_account",
	    content: JSON.stringify(wr),
	    onComplete: function(response) {
		my_log("Here here: Comepleted my_sign_in response", new Error);
		my_log("Here here: Response status: " + response.status, new Error);
		my_log("Here here: Response status txt: " + response.statusText, new Error);
		my_log("Here here: Response text: " + response.text, new Error);
		my_log("Here here: Response json: " + response.json, new Error);
		my_log("Here here: Response headers: " + response.headers, new Error);

		if (response.status == 200) {
		    var data = response.text;
		    if (data.split(' ')[0] == 'Success') {
			sender_worker.port.emit("login-success",  {
				type: "login-success", 
				    desc: "You have logged-in successfully"
				    });

			current_user = username;
			pii_vault.current_user = username;
			vault_write("current_user", pii_vault.current_user);
					    
			sign_in_status = 'signed-in';
			pii_vault.sign_in_status =  'signed-in';
			vault_write("sign_in_status", pii_vault.sign_in_status);
					    
			var new_guid = data.split(' ')[1];
			if (pii_vault.guid != new_guid) {
			    //Reset pii_vault.
			    pii_vault = { "options" : {}, "config": {}};
			    pii_vault.guid = new_guid;
			    my_log("sign_in(): Updated GUID in vault: " + pii_vault.guid, new Error);
			    vault_write("guid", pii_vault.guid);
						
			    current_user = username;
			    pii_vault.current_user = username;
			    vault_write("current_user", pii_vault.current_user);
						
			    sign_in_status = 'signed-in';
			    pii_vault.sign_in_status =  'signed-in';
			    vault_write("sign_in_status", pii_vault.sign_in_status);
			}
			//In case GUID has changed, call init() to create new fields. Otherwise it
			//will not do anything.
			vault_read();
			vault_init();
			my_log("APPU DEBUG: Account sign-in was success, new_guid: " + new_guid, new Error);
			//Just to report our status
			pii_check_if_stats_server_up();
		    }
		    else if (data.split(' ')[0] == 'Failed') {
			sender_worker.port.emit("login-failure",  {
				type: "login-failure", 
				    desc: 'Failed to sign-in (Possibly username or password is wrong)'
				    });
			my_log("APPU DEBUG: Account sign-in was failure", new Error);
		    }
		    else {
			sender_worker.port.emit("login-failure",  {
				type: "login-failure", 
				    desc: "Account sign-in failure for unknown reasons"
				    });
			my_log("APPU DEBUG: Account sign-in was failure, Unknown reason", new Error);
		    }
		}
		else {
		    //This means that HTTP response is other than 200 or OK
		    print_appu_error("Appu Error: Account sign-in failed at the server: " 
				     + status.toString() + " @ " + (new Date()));

		    sender_worker.port.emit("login-failure",  {
			    type: "login-failure", 
				desc: "Account sign-in failed, possibly service is down"
				});
		    my_log("APPU DEBUG: Account creation was failure: Unknown Reason", new Error);
		}
	    }
	});

    r.post();
}

function close_all_report_tabs() {
    my_log("Here here: Now closing all reports tabs: " + report_tab_ids.length, new Error);
    for(var i = 0; i < tabs.length; i++) {
	for (var j = 0; j < report_tab_ids.length; j++) {
	    if(tabs[i].id == report_tab_ids[j]) {
		my_log("Here here: Closing report tab-ID: " + tabs[i].id, new Error);
		tabs[i].close();
	    }
	}
    }
}

function close_all_myfootprint_tabs() {
    my_log("Here here: Now closing all my-footprint tabs: " + myfootprint_tab_ids.length, new Error);
    for(var i = 0; i < tabs.length; i++) {
	for (var j = 0; j < myfootprint_tab_ids.length; j++) {
	    if(tabs[i].id == myfootprint_tab_ids[j]) {
		my_log("Here here: Closing my-footprint tab-ID: " + tabs[i].id, new Error);
		tabs[i].close();
	    }
	}
    }
}

function sign_out() {
    //First close all old tabs for current user
    close_all_report_tabs();
    close_all_myfootprint_tabs();

    //Reset pii_vault.
    pii_vault = { "options" : {}, "config": {}};
    current_user = "default";
    pii_vault.guid = default_user_guid;
    sign_in_status = 'not-signed-in';

    my_log("sign_out(): Updated GUID in vault: " + pii_vault.guid, new Error);
    vault_write("guid", pii_vault.guid);

    pii_vault.current_user = current_user;
    my_log("sign_out(): Updated CURRENT_USER in vault: " + pii_vault.current_user, new Error);
    vault_write("current_user", pii_vault.current_user);

    pii_vault.sign_in_status =  sign_in_status;
    my_log("sign_out(): Updated SIGN_IN_STATUS in vault: " + pii_vault.sign_in_status, new Error);
    vault_write("sign_in_status", pii_vault.sign_in_status);

    //This is a default user, read default values and initialize those that dont exist
    vault_read();
    vault_init();
}

// ************ END OF Sign-in Code ******************


// ************ START OF Vault Code ******************
var on_disk_values = {
    "top_level" : [
		   "current_user",
		   "sign_in_status",
		   "salt_table",
		   "initialized",
		   "total_site_list",
		   "password_hashes",
		   "past_reports",
		   ],
    "config" : [
		"deviceid",
		"current_version",
		"status",
		"disable_period",
		"disable_start",
		"enable_timer",
		"reporting_hour",
		"next_reporting_time",
		"report_reminder_time",
		"reportid",
		],
    "options" : [
		 "blacklist",
		 "dontbuglist",
		 "report_setting",
		 ],
    "current_report" : [
			"initialize_time",
			"reportid",
			"deviceid",
			"report_modified",
			"guid",
			"num_report_visits",
			"report_time_spent",
			"appu_errors",
			"num_myfootprint_visits",
			"myfootprint_time_spent",
			"report_reviewed",
			"user_approved",
			"input_fields",
			"send_attempts",
			"extension_version",
			"extension_updated",
			"scheduled_report_time",
			"actual_report_send_time",
			"report_setting",
			"send_report_postponed",
			"num_total_sites",
			"total_time_spent",
			"total_time_spent_logged_in",
			"total_time_spent_wo_logged_in",
			"num_user_account_sites",
			"user_account_sites",
			"num_non_user_account_sites",
			"appu_disabled",
			"dontbuglist",
			"num_pwds",
			"pwd_groups",
			"pwd_similarity",
			"downloaded_pi",
			"common_fields",
			"pwd_reuse_warnings",
			"browser",
			"browser_version",
			"os",
			"os_version",
			"layout_engine",
			"layout_engine_version",
			],
    "aggregate_data" : [
			"initialized_time",
			"num_viewed",
			"total_time_spent",
			"num_total_sites",
			"all_sites_total_time_spent",
			"all_sites_stats_start",
			"num_user_account_sites",
			"user_account_sites",
			"num_non_user_account_sites",
			"non_user_account_sites",
			"num_pwds",
			"pwd_groups",
			"pwd_similarity",
			"per_site_pi",
			"pi_field_value_identifiers",
			],
}

//Initializing each property. 
//TODO: Perhaps a better way is to write a generic function
//that accepts property_name and property initializer for that property.
//It will test if property exists. If not, then call the initializer function on that property.
//It will shorten the code and make it decent.
function vault_init() {
    var vault_modified = false;
    
    my_log("vault_init(): Initializing missing properties from last release", new Error);
    // All top level values
    if (!pii_vault.guid) {
	//Verifying that no such user-id exists is taken care by
	//Create Account or Sign-in.
	//However, if there is a duplicate GUID then we are in trouble.
	//Need to take care of that somehow.
	pii_vault.guid = generate_random_id();
	
	my_log("vault_init(): Updated GUID in vault: " + pii_vault.guid, new Error);
	vault_write("guid", pii_vault.guid);
	
	pii_vault.current_user = current_user;
	vault_write("current_user", pii_vault.current_user);
	
	pii_vault.sign_in_status = sign_in_status;
	vault_write("sign_in_status", pii_vault.sign_in_status);
    }
    
    if (!pii_vault.salt_table) {
	var salt_table = {};
	//current_ip for current input, not ip address
	var current_ip = pii_vault.guid;
	for(var i = 0; i < 1000; i++) {
	    salt_table[i] = CryptoJS.SHA1(current_ip).toString();
	    current_ip = salt_table[i];
	}
	pii_vault.salt_table = salt_table;
	
	my_log("vault_init(): Updated SALT TABLE in vault", new Error);
	vault_write("salt_table", pii_vault.salt_table);
    }
    
    if (!pii_vault.initialized) {
	pii_vault.initialized = true;
	my_log("vault_init(): Updated INITIALIZED in vault", new Error);
	vault_write("initialized", pii_vault.initialized);
	}
    
    if (!pii_vault.total_site_list) {
	// This is maintained only to calculate total number of DIFFERENT sites visited
	// from time to time. Its reset after every new current_report is created.
	pii_vault.total_site_list = [];
	my_log("vault_init(): Updated TOTAL_SITE_LIST in vault", new Error);
	vault_write("total_site_list", pii_vault.total_site_list);
    }
    
    if (!pii_vault.password_hashes) {
	// This is maintained separarely from current_report as it should not
	// be sent to the server. 
	// Structure is: Key: 'username:etld'
	// Value: { 
	//    'pwd_full_hash':'xyz', 
	//    'pwd_short_hash':'a', 
	//    'salt' : 'zz',
	//    'pwd_group' : '',
	//    'initialized': Date } 
	pii_vault.password_hashes = {};
	my_log("vault_init(): Updated PASSWORD_HASHES in vault", new Error);
	vault_write("password_hashes", pii_vault.password_hashes);
    }

    if (!pii_vault.past_reports) {
	pii_vault.past_reports = [];
	my_log("vault_init(): Updated PAST_REPORTS in vault", new Error);
	vault_write("past_reports", pii_vault.past_reports);
    }
    
    // All config values
    if (!pii_vault.config.deviceid) {
	//A device id is only used to identify all reports originating from a 
	//specific Appu install point. It serves no other purpose.
	pii_vault.config.deviceid = generate_random_id();
	
	my_log("vault_init(): Updated DEVICEID in vault: " + pii_vault.config.deviceid, new Error);
	flush_selective_entries("config", ["deviceid"]);
    }
    
    if (!pii_vault.config.current_version) {
	var response_text = read_file('manifest.json');
	var manifest = JSON.parse(response_text);
	pii_vault.config.current_version = manifest.version;
	my_log("vault_init(): Updated CURRENT_VERSION in vault: " + pii_vault.config.current_version, new Error);
	flush_selective_entries("config", ["current_version"]);
    }
    
    if (!pii_vault.config.status) {
	pii_vault.config.status = "active";
	    my_log("vault_init(): Updated STATUS in vault", new Error);
	    vault_write("config:status", pii_vault.config.status);
    }
    
    if (!pii_vault.config.disable_period) {
	pii_vault.config.disable_period = -1;
	    my_log("vault_init(): Updated DISABLE_PERIOD in vault", new Error);
	    vault_write("config:disable_period", pii_vault.config.disable_period);
    }
    
    if (!pii_vault.config.reporting_hour) {
	pii_vault.config.reporting_hour = 0;
	//Random time between 5 pm to 8 pm. Do we need to adjust according to local time?
	var rand_minutes = 1020 + Math.floor(Math.random() * 1000)%180;
	pii_vault.config.reporting_hour = rand_minutes;
	my_log("vault_init(): Updated REPORTING_HOUR in vault", new Error);
	vault_write("config:reporting_hour", pii_vault.config.reporting_hour);
    }    
    
    if (!pii_vault.config.next_reporting_time) {
	var curr_time = new Date();
	//Advance by 3 days. 
	curr_time.setMinutes( curr_time.getMinutes() + 4320);
	//Third day's 0:0:0 am
	curr_time.setSeconds(0);
	curr_time.setMinutes(0);
	curr_time.setHours(0);
	curr_time.setMinutes( curr_time.getMinutes() + pii_vault.config.reporting_hour);
	//Start reporting next day
	pii_vault.config.next_reporting_time = curr_time.toString();
	
	my_log("Report will be sent everyday at "+ Math.floor(rand_minutes/60) + ":" + (rand_minutes%60), new Error);
	my_log("Next scheduled reporting is: " + curr_time, new Error);
	my_log("vault_init(): Updated NEXT_REPORTING_TIME in vault", new Error);
	vault_write("config:next_reporting_time", pii_vault.config.next_reporting_time);
    }
    
    if (!pii_vault.config.report_reminder_time) {
	pii_vault.config.report_reminder_time = -1;
	my_log("vault_init(): Updated REPORT_REMINDER_TIME in vault", new Error);
	vault_write("config:report_reminder_time", pii_vault.config.report_reminder_time);
    }
    
    if (!pii_vault.config.reportid) {
	pii_vault.config.reportid = 1;
	my_log("vault_init(): Updated REPORTID in vault", new Error);
	vault_write("config:reportid", pii_vault.config.reportid);
    }
    
    // All options values
    if (!pii_vault.options.blacklist) {
	pii_vault.options.blacklist = [];
	my_log("vault_init(): Updated BLACKLIST in vault", new Error);
	vault_write("options:blacklist", pii_vault.options.blacklist);
    }
    
    if (!pii_vault.options.dontbuglist) {
	pii_vault.options.dontbuglist = [];
	my_log("vault_init(): Updated DONTBUGLIST in vault", new Error);
	vault_write("options:dontbuglist", pii_vault.options.dontbuglist);
    }
    
    //Three different types of reporting.
    //Manual: If reporting time of the day and if report ready, interrupt user and ask 
    //        him to review, modify and then send report.
    //Auto: Send report automatically when ready.
    //Differential: Interrupt user to manually review report only if current report
    //                   entries are different from what he reviewed in the past.
    //                   (How many past reports should be stored? lets settle on 10 for now?).
    //                   Highlight the different entries with different color background.
    if (!pii_vault.options.report_setting) {
	pii_vault.options.report_setting = "manual";
	my_log("vault_init(): Updated REPORT_SETTING in vault", new Error);
	vault_write("options:report_setting", pii_vault.options.report_setting);
    }    

    // All current report values
    if (!pii_vault.current_report) {
	pii_vault.current_report = initialize_report();
	my_log("vault_init(): Updated CURRENT_REPORT in vault", new Error);
	
	flush_current_report();
    }
    
    // All aggregate data values
    if (!pii_vault.aggregate_data) {
	pii_vault.aggregate_data = initialize_aggregate_data();
	my_log("vault_init(): Updated AGGREGATE_DATA in vault", new Error);
	
	flush_aggregate_data();
    }
}

function vault_read() {
    try {
	pii_vault.guid = JSON.parse(localStorage.guid);
	if (pii_vault.guid) {
	    for (var k in on_disk_values) {
		if (on_disk_values.hasOwnProperty(k)) {
		    var read_key_prefix = pii_vault.guid + ":";
		    if (k != 'top_level') {
			read_key_prefix += (k + ":");
		    }
		    var all_properties = on_disk_values[k];
		    for (var i = 0; i < all_properties.length; i++) {
			var read_key = read_key_prefix + all_properties[i];
			try {
			    var val = JSON.parse(localStorage[read_key]);
			    if (k === 'top_level') {
				pii_vault[all_properties[i]] = val;
				if (all_properties[i] == 'current_user') {
				    current_user = val;
				}
				if (all_properties[i] == 'sign_in_status') {
				    sign_in_status = val;
				}
			    }
			    else {
				if (!pii_vault[k]) {
				    pii_vault[k] = {};
				}
				pii_vault[k][all_properties[i]] = val;
			    }
			}
			catch (e) {

			}
		    }
		}
	    }
	    if(pii_vault.guid) {
		my_log("User Id: " + pii_vault.guid, new Error);
	    }
	    if("salt_table" in pii_vault) {
		//my_log("salt_table length: " + Object.size(pii_vault.salt_table));
	    }
	}
	else {
	    my_log("No valid guid found", new Error);
	    pii_vault = { "options" : {}, "config": {}};
	}
    }
    catch (e) {
	my_log("Loading extension for the first time. Initializing extension data", new Error);
	pii_vault = { "options" : {}, "config": {}};
    }
}

//Since this function is getting called async from many different points,
//ideally it should have a lock to avoid race conditions (and possibly corruption).
//However, apparently JS is threadless and JS engine takes care of this issue
//under the hood. So we are safe.
function vault_write(key, value) {
    if (value !== undefined) {
	if (key && key == "guid") {
	    //my_log("APPU DEBUG: vault_write(), key: " + key + ", " + value);
	    localStorage[key] = JSON.stringify(value);
	}
	else if (key !== undefined) {
	    var write_key = pii_vault.guid + ":" + key;
	    //my_log("APPU DEBUG: vault_write(), key: " + write_key + ", " + value);
	    localStorage[write_key] = JSON.stringify(value);
	    if (key.split(':').length == 2 && key.split(':')[0] === 'current_report') {
		//This is so that if the reports tab queries for current_report,
		//we can send it an updated one. There is no need to flush this to disk.
		pii_vault.current_report.report_updated = true;
	    }
	}
    }
    else {
	my_log("Appu Error: vault_write(), Value is empty for key: " + key, new Error);
	print_appu_error("Appu Error: vault_write(), Value is empty for key: " + key);
    }
}

function flush_current_report() {
    for (var j = 0; j < on_disk_values.current_report.length; j++) {
	var write_key = "current_report:" + on_disk_values.current_report[j];
	vault_write(write_key, pii_vault.current_report[on_disk_values.current_report[j]]);
    }
}

function flush_aggregate_data() {
    for (var j = 0; j < on_disk_values.aggregate_data.length; j++) {
	var write_key = "aggregate_data:" + on_disk_values.aggregate_data[j];
	vault_write(write_key, pii_vault.aggregate_data[on_disk_values.aggregate_data[j]]);
    }
}

function flush_selective_entries(struct_name, entry_list) {
    for (var j = 0; j < entry_list.length; j++) {
	var write_key = struct_name + ":" + entry_list[j];
	vault_write(write_key, pii_vault[struct_name][entry_list[j]]);
    }
}

function my_set_current_report() {
    my_log("Here here: In vault:my_set_current_report()", new Error);
    pii_vault.current_report = {
	"init" : true,
    }
}

// ************ END OF Vault Code ******************


// ************ START OF background Code ******************

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


function register_menu_message_listeners() {
    appu_menu_panel.port.on("displayed", function(m) {
	    appu_menu_panel.resize(320, m.height + 35);
	    appu_menu_panel.port.emit("resized");
	});
    
    appu_menu_panel.port.on("get-signin-status", function(m) {
	    var resp = {};
	    my_log("Here here: XXXXXXXXXXXXXX Got message get-signin-status", new Error);
	    appu_menu_panel.port.emit("signin-status-response", {
		    'login_name' : current_user,
			'status' : sign_in_status,
			'user' : current_user,
			'appu_status' : pii_vault.config.status,
			});
	});
    
    appu_menu_panel.port.on("open-sign-in", function(message) {
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
			my_log("Here here: signinworker: " + JSON.stringify(Object.keys(sign_in_worker)), new Error);
			my_log("Here here: signinworker-url: " + this.url, new Error);
			
			sign_in_worker.port.on("get-version", function(args) {
				my_log("Here here: Got get-version", new Error);
				sign_in_worker.port.emit("get-version-response", {
					"version" : pii_vault.config.current_version
					    });
			    });
			
			sign_in_worker.port.on('get-signin-status', function(args) {
				my_log("Here here: Got get-signin-status", new Error);
				sign_in_worker.port.emit("get-signin-status-response", {
					'login_name' : current_user,
					    'status' : sign_in_status,
					    'user' : current_user,
					    'appu_status' : pii_vault.config.status,
					    });
			    });
			
			sign_in_worker.port.on('sign-in', function(args) {
				my_log("Here here: Got sign-in", new Error);
				sign_in(sign_in_worker,
						   args['username'],
						   args['password']);
			    });

			sign_in_worker.port.on('create-account', function(args) {
				my_log("Here here: Got create-account", new Error);
				create_account(sign_in_worker,
					       args['username'],
					       args['password']);
			    });
		    }
		});	    
	});

    appu_menu_panel.port.on("sign-out", function(message) {
	    appu_menu_panel.hide();
	    sign_out();
	});


    appu_menu_panel.port.on("open-report", function(message) {
	    appu_menu_panel.hide();
	    tabs.open({
		    url: data.url("report.html"),
			onOpen: function(tab) {
		    },
			onReady: function(tab) {
			var report_worker = tab.attach({
				contentScriptFile: [
						    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
						    data.url("thirdparty/bootstrap/js/bootstrap.min.js"),
						    data.url("thirdparty/DataTables-1.9.4/media/js/jquery.dataTables.js"),
						    data.url("thirdparty/DataTables-1.9.4/media/js/paging.js"),
						    data.url("report_utility.js"),
						    data.url("report.js"),
						    ]
			    });

			report_tab_ids.push(tab.id);
		    }
		});	    
	});

    appu_menu_panel.port.on("open-myfootprint", function(message) {
	    appu_menu_panel.hide();
	    tabs.open({
		    url: data.url("myfootprint.html"),
			onOpen: function(tab) {
		    },
			onReady: function(tab) {
			var myfootprint_worker = tab.attach({
				contentScriptFile: [
						    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
						    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-ui-1.9.1.custom.js"),
						    data.url("thirdparty/sprintf-0.7-beta1.js"),
						    data.url("myfootprint.js"),
						    ]
			    });

			myfootprint_tab_ids.push(tab.id);
		    }
		});	    
	});

    appu_menu_panel.port.on("open-options", function(message) {
	    appu_menu_panel.hide();
	    tabs.open({
		    url: data.url("options.html"),
			onOpen: function(tab) {
		    },
			onReady: function(tab) {
			var options_worker = tab.attach({
				contentScriptFile: [
						    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
						    data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-ui-1.9.1.custom.js"),
						    data.url("options.js"),
						    ]
			    });
		    }
		});	    
	});


    appu_menu_panel.port.on("open-about", function(message) {
	    appu_menu_panel.hide();
	    tabs.open({
		    url: "appu.gtnoise.net",
		});	    
	});

    appu_menu_panel.port.on("open-feedback", function(message) {
	    appu_menu_panel.hide();
	    tabs.open({
		    url: data.url("feedback.html"),
		});	    
	});

    appu_menu_panel.port.on("status_change", function(message) {
	    appu_menu_panel.hide();
	    pii_modify_status(message);
	});
}

register_menu_message_listeners();

var manifest = data.load("manifest.json");
manifest = JSON.parse(manifest);

function detachWorker(worker, workerArray) {
    var index = workerArray.indexOf(worker);
    if(index != -1) {
	workerArray.splice(index, 1);
    }
}

function register_worker_message_listeners(worker) {

    worker.port.on("simulate_click_done", function(message) {
	    my_log("Here here: simulate_click_done", new Error);
	});

    //DONE messages
    worker.port.on("check_passwd_reuse", function(message) {
	    my_log("Here here: check_passwd_reuse", new Error);
	    var sender = { 'tab': {}};
	    sender.tab.id = worker.tab.id;

	    message.domain = tld.getDomain(message.domain);
	    console.log("APPU DEBUG: (" + message.caller + ", " + message.pwd_sentmsg +
			"), Value of is_password_stored: " + message.is_stored);
	    var r = pii_check_passwd_reuse(message, sender);

	    //Add the current pwd info to pending warnings
	    var pend_warn = object.extend({}, r);

	    pending_warnings[sender.tab.id] = {
		'pending_warnings' : pend_warn,
		'passwd' : message.passwd,
		'pwd_strength' : r.pwd_strength,
		'domain' : message.domain,
		'username' : '',
		'is_stored' : message.is_stored,
	    };

	    worker.port.emit("check_passwd_reuse_response", r);
	});


    worker.port.on("explicit_sign_out", function(message) {
	    my_log("Here here: explicit_sign_out", new Error);
	    var domain = tld.getDomain(message.domain);
	    add_domain_to_uas(domain);
	    
	    pii_vault.current_report.user_account_sites[domain].pwd_unchanged_duration =
		get_pwd_unchanged_duration(domain);
	    pii_vault.current_report.user_account_sites[domain].num_logouts += 1;
	    flush_selective_entries("current_report", ["user_account_sites"]);
	    send_user_account_site_row_to_reports(domain);
	    
	    console.log("APPU DEBUG: Explicitly signed out from: " + tld.getDomain(domain));
	});

    worker.port.on("signed_in", function(message) {
	    my_log("Here here: signed_in", new Error);
	    var sender = { 'tab': {}};
	    sender.tab.id = worker.tab.id;

	    var domain = tld.getDomain(message.domain);

	    if (message.value == 'yes') {
		console.log("APPU DEBUG: Signed in for site: " + tld.getDomain(message.domain));
		
		add_domain_to_uas(domain);
		
		pii_vault.current_report.user_account_sites[domain].pwd_unchanged_duration =
		    get_pwd_unchanged_duration(domain);
		flush_selective_entries("current_report", ["user_account_sites"]);

		if (sender.tab.id in pending_pi_fetch) {
		    if (pending_pi_fetch[sender.tab.id] == domain) {
			console.log("APPU DEBUG: domain: " + domain + ", tab-id: " + sender.tab.id);
			check_if_pi_fetch_required(domain, sender.tab.id);
		    }
		    else {
			pending_pi_fetch[sender.tab.id] = "";
		    }
		}
	    }
	    else if (message.value == 'no') {
		pending_pi_fetch[sender.tab.id] = "";
		console.log("APPU DEBUG: NOT Signed in for site: " + tld.getDomain(message.domain));
	    }
	    else if (message.value == 'unsure') {
		pending_pi_fetch[sender.tab.id] = "";
		console.log("APPU DEBUG: Signed in status UNSURE: " + tld.getDomain(message.domain));
	    }
	    else {
		console.log("APPU DEBUG: Undefined signed in value " +
			    message.value + ", for domain: " + tld.getDomain(message.domain));
	    }
	});

    worker.port.on("clear_pending_warnings", function(message) {
	    my_log("Here here: clear_pending_warnings", new Error);   
	    var sender = { 'tab': {}};
	    sender.tab.id = worker.tab.id;

	    //This message indicates that user has interacted with earlier warning in some way.
	    //Hence, its not the case that user did not get to read it due to page redirects
	    if(pending_warnings[sender.tab.id] != undefined) {
		var p = pending_warnings[sender.tab.id];
		vault_update_domain_passwd(p.domain, p.username, p.passwd, p.pwd_strength, p.is_stored);
	    }
	    pending_warnings[sender.tab.id] = undefined;
	});

    worker.port.on("time_spent", function(message) {
	    my_log("Here here: time_spent", new Error);
	    focused_tabs -= 1;
	    var domain = tld.getDomain(message.domain);

	    pii_vault.current_report.total_time_spent += message.time_spent;
	    if (message.am_i_logged_in) {
		pii_vault.current_report.total_time_spent_logged_in += message.time_spent;
	    }
	    else {
		pii_vault.current_report.total_time_spent_wo_logged_in += message.time_spent;
	    }
	    
	    flush_selective_entries("current_report", ["total_time_spent",
						       "total_time_spent_logged_in",
						       "total_time_spent_wo_logged_in"]);

	    pii_vault.aggregate_data.all_sites_total_time_spent += message.time_spent;
	    flush_selective_entries("aggregate_data", ["all_sites_total_time_spent"]);
	    if (domain in pii_vault.current_report.user_account_sites) {
		pii_vault.current_report.user_account_sites[domain].tts += message.time_spent;
		if (message.am_i_logged_in) {
		    pii_vault.current_report.user_account_sites[domain].tts_login += message.time_spent;
		}
		else {
		    pii_vault.current_report.user_account_sites[domain].tts_logout += message.time_spent;
		}
		flush_selective_entries("current_report", ["user_account_sites"]);
		send_user_account_site_row_to_reports(domain);
	    }
	});

    worker.port.on("i_have_focus", function(message) {
	    my_log("Here here: i_have_focus", new Error);
	    focused_tabs += 1;
	});

    worker.port.on("remind_report_later", function(message) {
	    my_log("Here here: remind_report_later", new Error);
	    report_reminder_later(report_reminder_interval);
	});

    worker.port.on("close_report_reminder", function(message) {
	    my_log("Here here: close_report_reminder", new Error);
	    close_report_reminder_message();
	});

    worker.port.on("review_and_send_report", function(message) {
	    my_log("Here here: review_and_send_report", new Error);
	    open_reports_tab();
	});

    worker.port.on("user_input", function(message) {
	    my_log("Here here: user_input", new Error);
	    pii_log_user_input_type(message);
	});

    worker.port.on("check_blacklist", function(message) {
	    my_log("Here here: check_blacklist", new Error);
	    var r = pii_check_blacklisted_sites(message);
	    if (r.blacklisted == "no") {
		var etld = tld.getDomain(message.domain);

		if(pii_vault.total_site_list.indexOf(etld) == -1) {

		    pii_vault.total_site_list.push(etld);
		    vault_write("total_site_list", pii_vault.total_site_list);
		    pii_vault.current_report.num_total_sites += 1;
		    flush_selective_entries("current_report", ["num_total_sites"]);
		    pii_vault.aggregate_data.num_total_sites += 1;
		    flush_selective_entries("aggregate_data", ["num_total_sites"]);
		}
	    }
	    worker.port.emit("check_blacklist_response", r);
	});
    
    worker.port.on("check_pending_warning", function(message) {
	    my_log("Here here: check_pending_warning", new Error);
	    var sender = { 'tab': {}};
	    sender.tab.id = worker.tab.id;
	    var r = pii_check_pending_warning(message, sender);
	    r.id = sender.tab.id;
	    worker.port.emit("check_pending_warning_response", r);
	});

    worker.port.on("am_i_active", function(message) {
	    my_log("Here here: am_i_active", new Error);
	    var r = {};
	    r.data_dir_url = data.url("");
	    if (worker.tab.id == tabs.activeTab.id)  {
		r.am_i_active = true;
		worker.port.emit("am_i_active_response", r);
	    }
	    else {
		r.am_i_active = false;
		worker.port.emit("am_i_active_response", r);
	    }
	});

    worker.port.on("query_status", function(message) {
	    my_log("Here here: query_status", new Error);
	    var r = {};
	    r.status = pii_vault.config.status;
	    if (worker.tab.id in template_processing_tabs) {
		if (template_processing_tabs[worker.tab.id] != "") {
		    // console.log(sprintf("APPU DEBUG: Tab %s was sent a go-to url earlier", worker.tab.id));
		    var dummy_tab_id = sprintf('tab-%s', worker.tab.id);
		    template_processing_tabs[worker.tab.id] = "";
		    // console.log("APPU DEBUG: YYY tabid: " + worker.tab.id + ", value: " + 
		    // template_processing_tabs[worker.tab.id]);
		    r.status = "process_template";
		    worker.port.emit("query_status_response", r);

		    $('#' + dummy_tab_id).trigger("page-is-loaded");
		}
		else {
		    r.status = "process_template";
		    worker.port.emit("query_status_response", r);
		}
	    }
	    else {
		worker.port.emit("query_status_response", r);
	    }
	});
}

function is_worker_present(w) {
    for (var i = 0; i < workers.length; i++) {
	if (workers[i].tab.id == w.tab.id) {
	    my_log("Here here: RETURNING TRUE", new Error);
	    return true;
	}
    }
    my_log("Here here: RETURNING FALSE", new Error);
    return false;
}


pageMod.PageMod({
	include: "*",
	    attachTo: "top",
	    onAttach: function(worker) {
	    if (!is_worker_present(worker)) {
		workers.push(worker);
		
		worker.on('detach', function () {
			detachWorker(this, workers);
		    });
		register_worker_message_listeners(worker);
	    }
	},
	    contentScriptFile: [
				data.url("thirdparty/sha1.js"),
				data.url("thirdparty/sprintf-0.7-beta1.js"),
				data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-1.8.2.js"),
				data.url("thirdparty/jquery-ui-1.9.1.custom/js/jquery-ui-1.9.1.custom.js"),
				data.url("passwd.js")
				],
	    contentStyleFile: [
			       data.url("thirdparty/jquery-ui-1.9.1.custom/css/appuwarning/jquery-ui-1.9.1.custom.css"),
			       data.url("passwd.css")
			       ],
	    });


//my_log("Here here: version: " + manifest['version']);
//my_log("Here here: vault_read is : " + toType(vault.vault_read));

//my_log("Here here: site is : " + tld.getDomain('a.b.google.com'));

function init_environ() {
    //my_log("Here here: initing environ");
    var pw = page_worker.Page({
	    contentScriptFile: [
				data.url("thirdparty/voodoo1/voodoo.js"),
				data.url("get_environ.js")
				]
	});
    
    pw.port.on("got_environ", function(rc) {
	    environ = object.extend(environ, rc);
	    my_log("Here here: callback for pg worker, voodoo: " + JSON.stringify(environ), new Error);
	    pw.destroy();
	    
	    // BIG EXECUTION START
	    vault_read();
	    vault_init();
	});
}

init_environ();


// **************** TEST CODE ********

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

function my_sign_in(username, password) {
    //zero out pii_vault first if guid is differnt
    var wr = { 
	'guid': pii_vault.guid, 
	'username': CryptoJS.SHA1(username).toString(), 
	'password' : CryptoJS.SHA1(password).toString(),
	'version' : pii_vault.config.current_version
    }

    var r = request({
	    url: "http://woodland.gtnoise.net:5005/sign_in_account",
	    content: JSON.stringify(wr),
	    onComplete: function(response) {
		my_log("Here here: Comepleted my_sign_in response", new Error);
		my_log("Here here: Response status: " + response.status, new Error);
		my_log("Here here: Response status txt: " + response.statusText, new Error);
		my_log("Here here: Response text: " + response.text, new Error);
		my_log("Here here: Response json: " + response.json, new Error);
		my_log("Here here: Response headers: " + response.headers, new Error);
	    }
	});

    r.post();
}

// timers.setTimeout(function() {
// 	my_sign_in("testuser2", "testuser2123")}, 5000);

my_log("Here here, test message 1", new Error);

function my_test() {
    // Get the worker class from a JavaScript module and unload it immediately
    var {Cu} = require("chrome");
    var {Worker} = Cu.import(data.url("dummy.jsm"));
    Cu.unload(data.url("dummy.jsm"));
    
    var hw = new Worker(data.url("hash.js"));
    my_log("Here here: hw: " + JSON.stringify(hw), new Error);
    hw.onmessage = function(event) {
	    my_log("Here here: Answer is: " + JSON.stringify(event));
    };
 
//     webWorker.addEventListener("message", function(event)
// 			       {
// 				   if (event.data == "done")
// 				       worker.port.emit("message", { text: 'done!' });
// 			       }, false);

    hw.postMessage({
	        'limit' : 1000000,
		'cmd' : 'hash',
		'pwd' : 'secret',
		});

}

//my_test();

my_log("Here here: data url: " + data.url(""), new Error);

function my_test_new() {
    const { Cc, Ci } = require("chrome");
    
    var mozIJSSubScriptLoader = Cc["@mozilla.org/moz/jssubscript-loader;1"]
	.getService(Ci.mozIJSSubScriptLoader);

    mozIJSSubScriptLoader.loadSubScript(data.url("test1.jsm"));
}

//my_test_new();

// function page_worker_test() {
//     var pw = page_worker.Page({
// 	    contentScriptFile: [
// 				data.url("test_web_worker.js")
// 				]
// 	});
    
//     pw.port.on("got_environ", function(rc) {
// 	});
// }

// page_worker_test();

// my_log("Here here: This is after page_worker code: ", new Error);

// timers.setTimeout(function() {
// 	my_log("Here here: ZZZZZZ", new Error);
//     }, 60 * 1000);


/////////// Here
const { ChromeWorker } = require("chrome");

var hw = new ChromeWorker(data.url("hash.js"));
my_log("Here here: hw: " + hw.postMessage, new Error);
hw.onmessage = function(event) {
    my_log("Here here: Answer is: " + JSON.stringify(event));
};

//     webWorker.addEventListener("message", function(event)
// 			       {
// 				   if (event.data == "done")
// 				       worker.port.emit("message", { text: 'done!' });
// 			       }, false);

hw.postMessage({
	'limit' : 10,
	    'cmd' : 'hash',
	    'pwd' : 'secret',
	    });
