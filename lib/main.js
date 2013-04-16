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


var CryptoJS = include_thirdparty("sha1.js").CryptoJS;

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

var tld = undefined;
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
	clearInterval(pii_vault.config.enable_timer);
	pii_vault.config.status = "active";
	pii_vault.config.disable_period = -1;
	flush_selective_entries("config", ["enable_timer", "status", "disable_period"]);

	chrome.browserAction.setIcon({path:'images/appu_new19.png'});

	chrome.tabs.query({}, function(all_tabs) {
	    for(var i = 0; i < all_tabs.length; i++) {
		chrome.tabs.sendMessage(all_tabs[i].id, {type: "status-enabled"});
	    }
	});

    }
    else if (message.status == "disable") {
	pii_vault.config.status = "disabled";
	pii_vault.config.disable_period = message.minutes;
	pii_vault.config.disable_start = (new Date()).toString();
	pii_vault.config.enable_timer = setInterval(start_time_loop, 1000);
	flush_selective_entries("config", ["disable_start", "enable_timer", "status", "disable_period"]);

	pii_vault.current_report.appu_disabled.push(message.minutes);
	flush_selective_entries("current_report", ["appu_disabled"]);

	chrome.browserAction.setIcon({path:'images/appu_new19_offline.png'});
	my_log((new Date()) + ": Disabling Appu for " + message.minutes + " minutes", new Error);

	chrome.tabs.query({}, function(all_tabs) {
	    for(var i = 0; i < all_tabs.length; i++) {
		chrome.tabs.sendMessage(all_tabs[i].id, {type: "status-disabled"});
	    }
	});

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
	clearInterval(pii_vault.config.enable_timer);
	pii_vault.config.status = "active";
	pii_vault.config.disable_period = -1;
	flush_selective_entries("config", ["enable_timer", "status", "disable_period"]);

	chrome.browserAction.setIcon({path:'images/appu_new19.png'});
	my_log((new Date()) + ": Enabling Appu", new Error);

	chrome.tabs.query({}, function(all_tabs) {
	    for(var i = 0; i < all_tabs.length; i++) {
		chrome.tabs.sendMessage(all_tabs[i].id, {type: "status-enabled"});
	    }
	});

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

    for (var i = 0; i < report_tab_ids.length; i++) {
	chrome.tabs.sendMessage(report_tab_ids[i], {
		type: "report-table-change-row",
		    table_name: "input_fields",
		    mod_type: "add",
		    changed_row: domain_input_elements,
		    });
    }
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
    var report_url = chrome.extension.getURL('report.html');
    chrome.tabs.create({ url: report_url });
    close_report_reminder_message();
}


function close_report_reminder_message() {
    chrome.tabs.query({}, function(all_tabs) {
	    for(var i = 0; i < all_tabs.length; i++) {
		chrome.tabs.sendMessage(all_tabs[i].id, {type: "close-report-reminder"});
	    }
	});
}


function report_reminder_later(message) {
    var curr_time = new Date();
    curr_time.setMinutes(curr_time.getMinutes() + report_reminder_interval);

    pii_vault.config.report_reminder_time = curr_time.toString();
    flush_selective_entries("config", ["report_reminder_time"]);
    pii_vault.current_report.send_report_postponed += 1;
    flush_selective_entries("current_report", ["send_report_postponed"]);

    my_log(sprintf("[%s]: Report Reminder time postponed for: %dm", new Date(), report_reminder_interval), new Error);

    chrome.tabs.query({}, function(all_tabs) {
	    for(var i = 0; i < all_tabs.length; i++) {
		chrome.tabs.sendMessage(all_tabs[i].id, {type: "close-report-reminder"});
	    }
	});
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

    response_report = $.extend(true, {}, original_report);
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
    for (var i = 0; i < report_tab_ids.length; i++) {
	chrome.tabs.sendMessage(report_tab_ids[i], {
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

function sign_out() {
    //First close all old tabs for current user
    for (var i = 0; i < report_tab_ids.length; i++) {
	chrome.tabs.remove(report_tab_ids[i]);
    }
    for (var i = 0; i < myfootprint_tab_ids.length; i++) {
	chrome.tabs.remove(myfootprint_tab_ids[i]);
    }

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


function register_message_listeners() {
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

    appu_menu_panel.port.on("sign-out", function() {
	    appu_menu_panel.hide();
	    sign_out();
	});
}

register_message_listeners();

var manifest = data.load("manifest.json");
manifest = JSON.parse(manifest);


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
	})
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