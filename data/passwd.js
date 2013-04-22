/*
* PII reuse/storage checker.
*/

var myID = -1;
var is_appu_active = false;
var last_user_interaction = undefined;
var am_i_logged_in = false;
var pwd_pending_warn_timeout = undefined;
var data_dir_url = undefined; 

function my_log(msg, error) {
    var ln = error.lineNumber;
    var fn = error.fileName.split('->').slice(-1)[0].split('/').splice(-1)[0];
    console.log(fn + "," + ln + ": " + msg);
}


function close_report_ready_modal_dialog() {
    $('#appu-report-ready').dialog("close");
}

function send_report_this_time() {
    var message = {};
    message.type = "report_user_approved";
    //'1' for current report
    message.report_number = 1;
    self.port.emit("report_user_approved", message);
    var message = {};
    message.type = "close_report_reminder";
    self.port.emit("close_report_reminder", message);
}

function review_report_this_time() {
    var message = {};
    message.type = "review_and_send_report";
    self.port.emit("review_and_send_report", message);
}

function report_reminder_later() {
    var message = {};
    message.type = "remind_report_later";
    self.port.emit("remind_report_later", message);
}

function close_report_reminder_message() {
    var message = {};
    message.type = "close_report_reminder";
    self.port.emit("close_report_reminder", message);
}

function show_report_ready_modal_dialog() {
    if ( typeof show_report_ready_modal_dialog.body_wrapped === 'undefined' ) {
	show_report_ready_modal_dialog.body_wrapped = false;
    }
    if ( typeof show_report_ready_modal_dialog.report_ready_dialog_box === 'undefined' ) {
	show_report_ready_modal_dialog.report_ready_dialog_box = null;
    }

    if (!show_report_ready_modal_dialog.body_wrapped) {
	show_report_ready_modal_dialog.body_wrapped = true;
	var report_message = "Appu would like to send anonymous report to its server. \
This report will indicate personal information reusage across sites. \
It will <b>NOT</b> send the actual information. <br/><br/> \
This step is <b>IMPORTANT</b> to find out how can you improve your online behavior<br/> \
You can delete entries from the report by reviewing it before sending it out";

	var report_dialog_msg = sprintf('<div id="appu-report-ready" class="appuwarning" title="Appu: Notification"> %s </div>', report_message);
	var report_dialog_element = $(report_dialog_msg);
	$("#appu-report-ready").remove();
	$('body').append(report_dialog_element);


	//In all popup notification cases, I am stopping further event propagation as we do not want
	//any side-effects on the native web application.
	show_report_ready_modal_dialog.report_ready_dialog_box = $('#appu-report-ready').dialog({ 
	    modal : true, 
	    zIndex: 200,
	    autoOpen : false,
	    draggable : false,
	    resizable : false,
	    position : [ window.innerWidth/2, window.innerHeight/2 ],
	    open : function (event, ui) {
		$('#appu-report-ready')
		    .dialog("option", "position", [
			window.innerWidth/2 - $('#appu-report-ready').width()/2, 
			window.innerHeight/2 - $('#appu-report-ready').height()
		    ]);
	    },
	    width: 550,
	    buttons : [
		{
		    text: "Send Report",
		    click: function(event) { 
			send_report_this_time();
			$(this).dialog("close"); 
			event.stopPropagation();
		    }
		},
		{
		    text: "Review & Send Report",
		    click: function(event) { 
			review_report_this_time();
			$(this).dialog("close");
			event.stopPropagation(); 
		    }
		},
		{
		    text: "Remind me in 30 minutes",
		    click: function(event) { 
			report_reminder_later();
			$(this).dialog("close");
			event.stopPropagation(); 
		    }
		}
	    ]});

	//This wrapping has to be done *ONLY* for dialog boxes. 
	//This is according to comment from their developer blog: 
	//http://filamentgroup.com/lab/using_multiple_jquery_ui_themes_on_a_single_page/#commentNumber4
	show_report_ready_modal_dialog.report_ready_dialog_box.parents('.ui-dialog:eq(0)')
	    .wrap('<div class="appuwarning appu-reporting-box"></div>');
	$('.appu-reporting-box .ui-dialog-titlebar-close')
	    .on("click", function() {close_report_reminder_message();});
    }

    var is_passwd_dialog_open = $('#appu-password-warning').dialog("isOpen");
    //my_log(sprintf("Appu: [%s]: APPU DEBUG: Time for Report Ready Notifiction", new Date()), new Error);

    if (is_passwd_dialog_open != true) {
	$('#appu-report-ready').dialog("open");
	$('.ui-dialog :button').blur();
    }
}

function get_password_initialized_readable(pwd_init_time) {
    var pwd_init_date = new Date(pwd_init_time);
    var curr_date = new Date();
    var msg = "";
    var fields = 0;

    var diff = curr_date - pwd_init_date;

//     if (diff <= (24 * 60 * 60 * 1000)) {
// 	return "1 day";
//     }

    var total_seconds = Math.floor(diff / 1000);
    var years = Math.floor(total_seconds / 31536000);
    var days = Math.floor((total_seconds % 31536000) / 86400);
    var hours = Math.floor(((total_seconds % 31536000) % 86400) / 3600);
    var minutes = Math.floor((((total_seconds % 31536000) % 86400) % 3600) / 60);
    var seconds = Math.floor((((total_seconds % 31536000) % 86400) % 3600) % 60);

    if (years != 0) {
	msg = years + " yr";
	msg += ((years > 1) ? "s" : "");
	fields++;
    }
    if (days != 0) {
	msg += (msg == "" ? (days + " day") : (", " + days + " day")); 
	msg += ((days > 1) ? "s" : "");
	fields++;
    }
    if (hours != 0 && (fields < 2)) {
	msg += (msg == "" ? (hours + " hr") : (", " + hours + " hr")); 
	msg += ((hours > 1) ? "s" : "");
	fields++;
    }
    if (minutes != 0 && (fields < 2)) {
	msg += (msg == "" ? (minutes + " min") : (", " + minutes + " min")); 
	msg += ((minutes > 1) ? "s" : "");
	fields++;
    }
    if (seconds != 0 && (fields < 2)) {
	msg += (msg == "" ? (seconds + " sec") : (", " + seconds + " sec")); 
	msg += ((seconds > 1) ? "s" : "");
	fields++;
    }
    return msg;
}

function is_passwd_reused(response) {
    if (response.is_password_reused == "yes") {
	//my_log("Appu: Password is reused", new Error);
	var alrt_msg = "<b style='font-size:16px'>Password Warning</b> <br/>" +
	    "Estimated Password Cracking Time: <b>" + response.pwd_strength.crack_time_display + "</b><br/>";

	if (response.initialized != 'Not sure') {
	    alrt_msg += "Password not changed for: <b>" + get_password_initialized_readable(response.initialized) + "</b>";
	}
	
	alrt_msg += "<br/><br/><b style='font-size:16px'> Reused In:</b><br/>";
	for (var i = 0; i < response.sites.length; i++) {
	    alrt_msg += response.sites[i] + "<br/>";
	}

	if(response.dontbugme == "no") {
	    var dialog_msg = sprintf('<div id="appu-password-warning" class="appuwarning" title="Appu: Notification"><p>%s</p></div>', alrt_msg);
	    var dialog_element = $(dialog_msg);
	    $("#appu-password-warning").remove();
	    $('body').append(dialog_element);

	    //This wrapping has to be done *ONLY* for dialog boxes. 
	    //This is according to comment from their developer blog: 
	    //http://filamentgroup.com/lab/using_multiple_jquery_ui_themes_on_a_single_page/#commentNumber4
	    $('#appu-password-warning').dialog({ 
		modal : true, 
		zIndex: 200,
		width: 450,
		//autoOpen : false,
		height: 250,
		maxHeight: 500,
		draggable : false,
		resizable : false,
		buttons : [
		    {
			text: "Close",
			click: function(event) { 
			    event.stopPropagation();
			    $(this).dialog("close"); 
			    var message = {};
			    message.type = "clear_pending_warnings";
			    self.port.emit("clear_pending_warnings", message);
			}
		    },
		    {
			text: "Don't bother me about this page further",
			click: function(event) { 
			    event.stopPropagation();
			    var message = {};
			    message.type = "add_to_dontbug_list";
			    message.domain = document.domain;
			    self.port.emit("add_to_dontbug_list", message);
			    
			    var message = {};
			    message.type = "clear_pending_warnings";
			    self.port.emit("clear_pending_warnings", message);
			    
			    $(this).dialog("close"); 
			}
		    }
		]  }).parents('.ui-dialog:eq(0)').wrap('<div class="appuwarning"></div>');;
	    
	    // $('#appu-password-warning').dialog("open");
	    $('.appuwarning .ui-dialog-titlebar-close')
		.on("click", function() {
		    var message = {};
		    message.type = "clear_pending_warnings";
		    self.port.emit("clear_pending_warnings", message);
		});

	    //$('.appuwarning .ui-dialog-titlebar').css("background-color", "DarkGreen");
	}
	else {
	    my_log("Appu: Not popping warning alert since the site is in \"don'tbug me list\"", new Error);
	}
	//window.setTimeout(function() { alert(alrt_msg); } , 1);
	my_log(alrt_msg, new Error);
    }
}

function check_passwd_reuse(jevent) {
    if ( jevent.target.value != "" ) {
	var message = {};
	message.type = "check_passwd_reuse";
	message.caller = "check_passwd_reuse";
	message.domain = document.domain;
	message.is_stored = is_password_stored(jevent.target);
	message.passwd = jevent.target.value;
	message.warn_later = false;
	self.port.emit("check_passwd_reuse", message, is_passwd_reused);
	$(jevent.target).data("is_reuse_checked", true);
	$(jevent.target).data("pwd_checked_for", message.passwd);
    }
}

//Readymade from StackOverFlow...
function check_associative_array_size(aa) {
    var size = 0, key;
    for (key in aa) {
        if (aa.hasOwnProperty(key)) size++;
    }
    return size;
}

function user_modifications(jevent) {
    var message = {};
    message.type = "user_input";
    message.domain = document.domain;
    message.attr_list = {};

    if ('name' in jevent.target.attributes) {
	message.attr_list['name'] = jevent.target.attributes['name'].value;
    }
    else {
	message.attr_list['name'] = 'no-name';
    }

    if ('type' in jevent.target.attributes) {
	message.attr_list['type'] = jevent.target.attributes['type'].value;
    }
    else {
	message.attr_list['type'] = 'no-type';
    }

    try {
	message.attr_list['length'] = $(jevent.target).val().length;
    }
    catch (e) {
	my_log("Appu Error: While calculating length", new Error);
	message.attr_list['length'] = -1;
    }

    if (check_associative_array_size(message.attr_list) > 0) {
	self.port.emit("user_input", message);
    }
    else {
	my_log("Appu WARNING: Captured an input elemnt change w/o 'name' or 'type'", new Error);
    }
}

//If 'ENTER' is pressed, then unfortunately browser will move on 
//(content scripts cannot hijack events from main scripts),
//before notification is flashed.
//In that case, show the warning as pending warning on the next page.
function check_for_enter(e) {
    if (e.which == 13) {
	if ( e.target.value != "" ) {
	    $(e.target).data("is_reuse_checked", true);
	    $(e.target).data("pwd_checked_for", e.target.value);

	    var message = {};
	    message.type = "check_passwd_reuse";
	    message.caller = "check_for_enter";
	    message.pwd_sentmsg = $(e.target).data("is_reuse_checked");
	    message.domain = document.domain;
	    message.is_stored = is_password_stored(e.target);
	    message.passwd = e.target.value;
	    message.warn_later = true;
	    self.port.emit("check_passwd_reuse", message);
	}
    }
}

function update_current_password(e) {
    if (e.which != 9) {
        //This is not a tab key. So that means user is actually modifying the values here.
	$(e.target).data("pwd_modified", true);
	$(e.target).data("pwd_current", e.target.value);
	password_changed(e.target);
     }
}

// This functions iterates over all the present
// password elements. It will store the value
// filled by browser (if passwords are stored in the browser).
// This is used to compare if user edited passwords later or
// if he just used values filled by browser.
function store_pwd_elements() {
    var ap = $('input:password');
    for (var i = 0; i < ap.length; i++) {
	$(ap[i]).data("pwd_element_id", i);
	$(ap[i]).data("pwd_orig", ap[i].value);
        if (ap[i].value.length > 0) {
	    $(ap[i]).data("pwd_stored", true);
        }
        else {
	    $(ap[i]).data("pwd_stored", false);
        }
	$(ap[i]).data("pwd_current", "");
	$(ap[i]).data("pwd_modified", false);
	$(ap[i]).data("pwd_checked_for", "");
    }
}

//Need to check usernames as well
function password_changed(pwd_elem) {
    if($(pwd_elem).data("pwd_modified") == false &&
       $(pwd_elem).data("pwd_orig") == pwd_elem.value) {
	//This is the most straightforward case. This means that password was not modified at all.
	//User is using the same password that was entered by the browser.
	$(pwd_elem).data("pwd_stored", true);
	return;
    }
    if($(pwd_elem).data("pwd_modified") == false &&
       $(pwd_elem).data("pwd_orig") != pwd_elem.value &&
       $(pwd_elem).data("pwd_current") == pwd_elem.value) {
	//This means that the user has actively modified the password sometime in the past.
	//So password stored is false.
	$(pwd_elem).data("pwd_stored", false);
	return;
    }
    if($(pwd_elem).data("pwd_modified") == false &&
       $(pwd_elem).data("pwd_orig") != pwd_elem.value &&
       $(pwd_elem).data("pwd_current") != pwd_elem.value) {
	//In this case, user did edit the password, but then he changed username to some username
	//that also has the password stored but is not equal to default uesrname that browser enters.
	//Hence, the password is still stored in the browser.
	$(pwd_elem).data("pwd_stored", true);
	$(pwd_elem).data("pwd_orig", pwd_elem.value);
	return;
    }
    if($(pwd_elem).data("pwd_modified") == true) {
	//In this case, user did edit the password, but then he changed username to some username
	//that also has the password stored but is not equal to default uesrname that browser enters.
	//Hence, the password is still stored in the browser.
	$(pwd_elem).data("pwd_modified", false);
	$(pwd_elem).data("pwd_stored", false);
	return;
    }
}

function is_password_stored(pwe) {
    password_changed(pwe);
    return $(pwe).data("pwd_stored");
}

function final_password_reuse_check() {
    var all_passwds = $("input:password");
    try {
	for(var i = 0; i < all_passwds.length; i++) {
            if (all_passwds[i].value != "" && 
		$(all_passwds[i]).is(":visible") == true) {
		
		if ($(all_passwds[i]).data("is_reuse_checked") == true &&
		    $(all_passwds[i]).data("pwd_checked_for") == all_passwds[i].value) {
		    continue;
		}

                var message = {};

		message.pwd_sentmsg = $(all_passwds[i]).data("is_reuse_checked");
                message.type = "check_passwd_reuse";
		message.caller = "final_password_reuse_check";
                message.domain = document.domain;
                message.passwd = all_passwds[i].value;
                message.is_stored = is_password_stored(all_passwds[i]);
                message.warn_later = true;
                self.port.emit("check_passwd_reuse", message);
                $(all_passwds[i]).data("is_reuse_checked", true);
            }
        }
    }
    catch (e) {
	my_log("Error: In exception", new Error);
    }
}

function check_for_visible_pwd_elements() {
    var all_pwds = $("input:password");
    var rc = false;

    if (all_pwds.length == 0) {
	return false;
    }

    all_pwds.each(function() {
	    if ($(this).is(":visible") == true) {
		rc = true;
	    }
	});    

    return rc;
}

function is_blacklisted(response) {
    if(response.blacklisted == "no") {
	if (!check_for_visible_pwd_elements()) {
	    //This means that its a successful login.
	    //Otherwise, password might be wrong.
	    check_pending_warnings();
	}
	else {
            //Register for password input type element. 
            $('body').on('focusout', 'input:password', check_passwd_reuse);
            $('body').on('keydown', 'input:password', check_for_enter);
            $('body').on('keyup', 'input:password', update_current_password);

            //Finally handle the case for someone enters password and then
            //with mouse clicks on "log in" 
            $(window).on('unload', final_password_reuse_check);
        }

	//Register for all input type elements. Capture any changes to them.
	//Log which input element user actively changes on a site.
	//DO NOT LOG changes themselves. 
	//This is an excercise to find out on which sites user submits inputs.
	//As always, delegate to "body" to capture dynamically added input elements
	//and also for better performance.
	$('body').on('change', ':input', user_modifications);
    }
    else {
	my_log("Appu: Disabled for this site", new Error);
    }
}

function get_permission_to_fetch_pi(domain) {
	var pi_permission_message = "Appu would like to download your personal information present on " + 
	    domain + ". This information <b>DOES NOT</b> get sent to the server. It'll <b>ALWAYS</b> stays \
on your local disk. <br/>\
If you choose to do so, Appu would open a new tab and download that information. \
<br/><br/>You can view downloaded information at 'Appu-Menu > My Footprint'. <br/> \
You can change the choice that you make now at any time from 'Appu-Menu > Options'. <br/><br/>\
Do you want Appu to download your personal information from this site?";

	var pi_permission_dialog_msg = sprintf('<div id="appu-pi-permission" class="appuwarning" title="Appu: Notification"> %s </div>', pi_permission_message);
	var pi_permission_dialog_element = $(pi_permission_dialog_msg);
	$("#appu-pi-permission").remove();
	$('body').append(pi_permission_dialog_element);

	//In all popup notification cases, I am stopping further event propagation as we do not want
	//any side-effects on the native web application.
	pi_permission_dialog_box = $('#appu-pi-permission').dialog({ 
	    modal : true, 
	    zIndex: 200,
	    autoOpen : false,
	    draggable : false,
	    resizable : false,
	    position : [ window.innerWidth/2, window.innerHeight/2 ],
	    open : function (event, ui) {
		$('#appu-pi-permission')
		    .dialog("option", "position", [
			window.innerWidth/2 - $('#appu-pi-permission').width()/2, 
			window.innerHeight/2 - $('#appu-pi-permission').height()
		    ]);
	    },
	    width: 550,
	    buttons : [
		{
		    text: "Always",
		    click: function(event) { 
			self.port.emit('fetch_pi_permission_response', {
			    'fetch_pi_permission' : 'always',
			});
			$(this).dialog("close"); 
			event.stopPropagation();
		    }
		},
		{
		    text: "Only this time",
		    click: function(event) { 
			self.port.emit('fetch_pi_permission_response', {
			    'fetch_pi_permission' : 'just-this-time',
			});
			$(this).dialog("close"); 
			event.stopPropagation();
		    }
		},
		{
		    text: "Never",
		    click: function(event) { 
			self.port.emit('fetch_pi_permission_response', {
			    'fetch_pi_permission' : 'never',
			});
			$(this).dialog("close"); 
			event.stopPropagation();
		    }
		}
	    ]});

	//This wrapping has to be done *ONLY* for dialog boxes. 
	//This is according to comment from their developer blog: 
	//http://filamentgroup.com/lab/using_multiple_jquery_ui_themes_on_a_single_page/#commentNumber4
	pi_permission_dialog_box.parents('.ui-dialog:eq(0)')
	    .wrap('<div class="appuwarning appu-permission-box"></div>');
	$('#appu-pi-permission').dialog("open");

	// $('.appu-permission-box .ui-dialog-titlebar-close')
	//     .on("click", function() {close_report_reminder_message();});
}

function show_pending_warnings(r) {
    if(r.pending == "yes") {
	var response = r.warnings;
	msg_type = (response.is_password_reused == "yes") ? "Warning" : "Information";
	    //my_log("Appu: Password is reused", new Error);
	var alrt_msg = "<b style='font-size:16px'>Password " + msg_type + "</b> <br/>" +
	    "Estimated Password Cracking Time: <b>" + response.pwd_strength.crack_time_display + "</b><br/>";

	if (response.initialized != 'Not sure') {
	    alrt_msg += "Password not changed for: <b>" + get_password_initialized_readable(response.initialized) + "</b>";
	}

	if (response.is_password_reused == "yes") {	    
	    alrt_msg += "<br/><br/><b style='font-size:16px'> Reused In:</b><br/>";
	    for (var i = 0; i < response.sites.length; i++) {
		alrt_msg += response.sites[i] + "<br/>";
	    }
	}
	
	var dialog_msg = sprintf('<div id="appu-password-pending-warning" class="appuwarning" title="Appu: Password Reuse %s"><p>%s</p></div>', msg_type, alrt_msg);
	var dialog_element = $(dialog_msg);
	$("#appu-password-pending-warning").remove();
	$('body').append(dialog_element);
	
	//This wrapping has to be done *ONLY* for dialog boxes. 
	//This is according to comment from their developer blog: 
	//http://filamentgroup.com/lab/using_multiple_jquery_ui_themes_on_a_single_page/#commentNumber4

	//debugger;
	$('#appu-password-pending-warning').dialog({
	    draggable : false,
	    resizable : false,
	    autoOpen : false,
	    width: 350,
	    maxHeight: 500,
	    //position : ['right', 'bottom'],
	    position : [window.innerWidth - 100, window.innerHeight - 220],
	    hide: { effect: 'drop', direction: "down" },
	    open : function (event, ui) {
		$('#appu-password-pending-warning')
		    .dialog("option", "position", [
			window.innerWidth - $('#appu-password-pending-warning').width(), 
			window.innerHeight - ($('#appu-password-pending-warning').height() +
					      ($('#appu-password-pending-warning').height()/2) - 20)
		    ]);
	    }
	}).parents('.ui-dialog:eq(0)').wrap('<div class="appuwarning"></div>'); 

	$('#appu-password-pending-warning').dialog("open");
	my_log("APPU DEBUG: Opened window at: " + new Date(), new Error);

	pwd_pending_warn_timeout = window.setTimeout(function(){
	    $('#appu-password-pending-warning').dialog('close');
	}, 5000);
	
	$('#appu-password-pending-warning').mouseover(function() {
	    window.clearTimeout(pwd_pending_warn_timeout);
	});

	$('#appu-password-pending-warning').mouseout(function() {
	    pwd_pending_warn_timeout = window.setTimeout(function(){
		$('#appu-password-pending-warning').dialog('close');
	    }, 5000);
	});
    }
}

function show_pending_warnings_async(r) {
    window.setTimeout(function() {show_pending_warnings(r)}, 2000);
}

function check_pending_warnings() {
    var message = {};
    message.type = "check_pending_warning";
    self.port.emit("check_pending_warning", message);
}

function is_status_active(response) {
    if (response.status == "active") {
	my_log(sprintf("Appu: [%s]: Extension is enabled", new Date()), new Error);
	is_appu_active = true;

	show_appu_monitor_icon();
	$(window).resize(show_appu_monitor_icon);

	var message = {};
	message.type = "check_blacklist";
	message.domain = document.domain;
	//Appu is enabled. Check if the current site is blacklisted.
	//If not, then register for password input type.
	self.port.emit("check_blacklist", message);

	// 5 seconds is just some random period to get page ready in case
	// of Ajax apps. (for e.g. in case of gmail, the .load() is fired
	// even if the page is absolutely blank).
	window.setTimeout(detect_if_user_logged_in, 5 * 1000);
    }
    else if(response.status == "process_template") {
	// I am created with the sole purpose of downloading PI information
	// Once that is done, I would be closed.
	my_log("Appu: Ready to process template", new Error);

	var template_msg = sprintf('<div id="appu-template-process" class="appuwarning" title="Appu: Downloading Information"><p>%s</p></div>', "DO NOT CLOSE, Appu is downloading your information");
	var dialog_element = $(template_msg);
	$("#appu-template-process").remove();
	$('body').append(dialog_element);
	
	//This wrapping has to be done *ONLY* for dialog boxes. 
	//This is according to comment from their developer blog: 
	//http://filamentgroup.com/lab/using_multiple_jquery_ui_themes_on_a_single_page/#commentNumber4
	$('#appu-template-process').dialog({
	    draggable : false,
	    resizable : false,
	    autoOpen : false,
	    //position : ['right', 'bottom'],
	    position : [ window.innerWidth/2, window.innerHeight/2 ],
	    open : function (event, ui) {
		$('#appu-template-process')
		    .dialog("option", "position", [
			window.innerWidth/2 - $('#appu-template-process').width()/2, 
			window.innerHeight/2 - $('#appu-template-process').height()
		    ]);
	    },
	}).parents('.ui-dialog:eq(0)').wrap('<div class="appuwarning"></div>'); 

	$('#appu-template-process').dialog("open");
    }
    else {
	my_log("Appu: Extension is currently disabled", new Error);
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

function simulate_click_worked(mutations, observer, simulate_done_timer, css_selector) {
    if ($(css_selector).length > 0) {
	my_log("APPU DEBUG: Simulate click was successful", new Error);
	observer.disconnect();
	window.clearTimeout(simulate_done_timer);
	var message = {};
	message.type = "simulate_click_done";
	self.port.emit("simulate_click_done", message);
    }
}

var start_focus_time = undefined;

function focus_check() {
    if (start_focus_time != undefined) {
	var curr_time = new Date();
	//Lets just put it for 4.5 minutes
	if((curr_time.getTime() - last_user_interaction.getTime()) > (270 * 1000)) {
	    //No interaction in this tab for last 5 minutes. Probably idle.
	    window_unfocused();
	}
    }
}

function window_focused(eo) {
    last_user_interaction = new Date();
    if (start_focus_time == undefined) {
	start_focus_time = new Date();
	// var message = {};
	// message.type = "i_have_focus";
	// self.port.emit("", message);
    }
}

function window_unfocused(eo) {
    if (start_focus_time != undefined) {
	var stop_focus_time = new Date();
	var total_focus_time = stop_focus_time.getTime() - start_focus_time.getTime();
	start_focus_time = undefined;
	var message = {};
	message.type = "time_spent";
	message.domain = document.domain;
	message.am_i_logged_in = am_i_logged_in;
	message.time_spent = total_focus_time;
	self.port.emit("time_spent", message);
    }
}


//Case insensitive "contains" .. from stackoverflow with thanks
//http://stackoverflow.com/questions/2196641/how-do-i-make-jquery-contains-case-insensitive-including-jquery-1-8
$.expr[":"].Contains = $.expr.createPseudo(function(arg) {
    return function( elem ) {
        return $(elem).text().toUpperCase().indexOf(arg.toUpperCase()) >= 0;
    };
});

//Detecting if a user has logged in or not is a bit tricky.
//Usually if a user has logged in, then there is a link somewhere on
//the webpage for logging out. That is a sufficient condition to
//identify that the user has logged in.
//However, for certain sites like stackoverflow, such a link is not
//"generated" until you click on the drop-down box for a logged in user
//(I am guessing this is because they also want to generate all sorts of
// stats for that user). 
//However, on SO, if a user has not logged in, then there is a prominent
//"log in" link. So for such site, detecting if user has logged in
//is negating the presence of "log in" link on the webpage.
//I am sure there will be sites that do no satisfy either category.
//But thats for later....

//If we find any log-in links, then the user has certainly not logged in.
function detect_login_links() {
    var signin_patterns = {
	"Sign in" : "^Sign in$", 
	"? Sign in" : "\\? Sign in$", 
	"Log in"  : "^Log in$" , 
	"Login"   : "^Login$"  ,
	"Sign In/Register for Account" : "^Sign In/Register for Account$" ,
    };

    var signin_elements = $([]);
    
    //my_log("APPU DEBUG: Detecting 'log in's", new Error);

    var signin_elements = detect_text_pattern(signin_patterns);

    return signin_elements;
}


function detect_text_pattern(patterns) {
    var detected_elements = $([]);
    Object.keys(patterns).forEach(function(value, index, array) {
	    detected_elements = detected_elements.add($(":Contains('" + value + "')").filter(function() { 
			var regex_val = patterns[value].toLowerCase();
			var text = $.trim($(this).text()).toLowerCase();
			var tagName = this.tagName;
			
			if (text == undefined || text == "") {
			    return false;
			}
			
			if (tagName == "SCRIPT" || 
			    tagName == "STYLE" ||
			    tagName == "NOSCRIPT" ) {
			    return false;
			}

// 			if (!$(this).is(":visible")) {
// 			    return false;
// 			}
			
			if (!text.match(regex_val)) {
			    return false;
			}
			
			return ($(this).children().length < 1); 
		    }));
	});
    return detected_elements;
}


function detect_input_type_pattern(patterns) {
    var detected_elements = $([]);
    Object.keys(patterns).forEach(function(value, index, array) {
	    detected_elements = detected_elements.add($(":input[value='"+ value +"']").filter(function() { 
			if (this.tagName == "SCRIPT") {
			    return false;
			}
			if (this.tagName == "NOSCRIPT") {
			    return false;
			}
			return ($(this).children().length < 1); 
		    }));
	});
    return detected_elements;
}


//If we can detect log-out links on a page then that means a user has
//certainly logged in.
function detect_logout_links() {
    var signout_patterns = {
	"Sign out" : "^Sign out$", 
	"? Sign out" : "\\? Sign out$", 
	"Log Out"  : "^Log Out$", 
	"Logout"   : "^Logout$",  
    };
   
    //my_log("APPU DEBUG: Detecting 'log out's", new Error);

    var signout_elements = detect_text_pattern(signout_patterns);

    //Special case for sites like Facebook
    if (signout_elements.length == 0) {
	signout_elements = detect_input_type_pattern(signout_patterns);
    }

    //Special case for sites like Dropbox....need to generalize it later
    if (signout_elements.length == 0 && (document.domain.match(/dropbox.com$/) != null)) {
	signout_elements = signout_elements.add($(":contains('Sign out')")
						.filter(function() { return (this.tagName == 'A'); }));
    }

    //Special case for sites like Github....need to generalize it later
    if (signout_elements.length == 0 && (document.domain.match(/github.com$/) != null)) {
	signout_elements = signout_elements.add($("#logout")
						.filter(function() { return (this.tagName == 'A'); }));
    }

    return signout_elements;
}

function monitor_explicit_logouts(eo) {
    my_log("APPU DEBUG", new Error);
    var signout_event = false;
    if ((eo.type == "click") || (eo.type == "keypress" && eo.which == 13)) {
	var message = {};
	message.type = "explicit_sign_out";
	message.domain = document.domain;
	self.port.emit("explicit_sign_out", message);
	my_log("APPU DEBUG: Sending message that I explicitly signed out", new Error);
    }
}

function detect_if_user_logged_in() {
    var signout_elements = detect_logout_links();
    var signin_elements = detect_login_links();

    if (signout_elements.length > 0 && signin_elements.length == 0) {
	var message = {};
	message.type = "signed_in";
	message.value = 'yes';
	message.domain = document.domain;
	self.port.emit("signed_in", message);
	my_log("APPU DEBUG: Sending message that I am signed in", new Error);
	am_i_logged_in = true;

	$(signout_elements).on('click.monitor_explicit_logouts', monitor_explicit_logouts);
	$(signout_elements).on('keypress.monitor_explicit_logouts', monitor_explicit_logouts);
    }
    else if (signin_elements.length > 0 && signout_elements.length == 0) {
	var message = {};
	message.type = "signed_in";
	message.value = 'no';
	message.domain = document.domain;
	self.port.emit("signed_in", message);
	my_log("APPU DEBUG: Sending message that I am *NOT* signed in", new Error);
    }
    else {
	var message = {};
	message.type = "signed_in";
	message.value = 'unsure';
	message.domain = document.domain;
	self.port.emit("signed_in", message);
	my_log("APPU DEBUG: Sending message that SignIn status is *UNSURE*", new Error);
    }
}

function update_status(new_status) {
    my_log("Here here, in the status message update", new Error);
    var dialog_msg = sprintf('<div id="appu-status-update-warning" class="appuwarning" title="Appu: Status Change"><p>%s</p><br/>%s</div>', new_status, new Date());
	var dialog_element = $(dialog_msg);
	$("#appu-status-update-warning").remove();
	$('body').append(dialog_element);
	
	//This wrapping has to be done *ONLY* for dialog boxes. 
	//This is according to comment from their developer blog: 
	//http://filamentgroup.com/lab/using_multiple_jquery_ui_themes_on_a_single_page/#commentNumber4

	$('#appu-status-update-warning').dialog({
	    draggable : false,
	    resizable : false,
	    autoOpen : false,
	    // position : ['right', 'bottom'],
	    // hide: { effect: 'drop', direction: "down" }
	    position : [window.innerWidth - 100, window.innerHeight - 220],
	    hide: { effect: 'drop', direction: "down" },
	    open : function (event, ui) {
		    //my_log("Here here: width, height: " + document.body.scrollLeft + ", " + document.body.scrollTop,
		    //	   new Error);
		$('#appu-status-update-warning')
		    .dialog("option", "position", [
			window.innerWidth - $('#appu-status-update-warning').width(), 
			window.innerHeight - ($('#appu-status-update-warning').height() +
					      ($('#appu-status-update-warning').height()/2) + 20)
		    ]);
	    },
	}).parents('.ui-dialog:eq(0)').wrap('<div class="appuwarning"></div>'); 

	$('#appu-status-update-warning').dialog("open");
	my_log("APPU DEBUG: Opened window at: " + new Date(), new Error);
	window.setTimeout(function(){
	    $('#appu-status-update-warning').dialog('close');
	    my_log("APPU DEBUG: Closed window at: " + new Date(), new Error);
	}, 3000);
}

function hide_appu_monitor_icon() {
    my_log("Here here: " + window.location + " HIDE MONITOR called: ", new Error);
    $("#appu-monitor-icon").hide();
}

function show_appu_monitor_icon() {
    if (is_appu_active) {
	if ($("#appu-monitor-icon").length == 0) {
	    var appu_img_src = data_dir_url + "images/appu_new19.png";
	    var appu_img = $("<img id='appu-monitor-icon' src='" + appu_img_src + "'></img>");
	    $("body").append(appu_img);
	}
	else {
	    $("#appu-monitor-icon").show();
	}
	    
	$("#appu-monitor-icon").css({
		"position" : "fixed",
		    //I have to use hardcoded value here because if I dynamically calculate
		    //the value using .height(), the element is not rendered and hence
		    //height is zero.
		    "top" : window.innerHeight - 19,
		    "left" : 0, 
		    });
	
	$(function() {
		$("#appu-monitor-icon").tooltip({ 
			    position: { my: "left+15 center-25", at: "right"},
			    tooltipClass : "appu-monitor-icon-tooltip",
			    });
	    });
    }
}

if (document.URL.match(/.pdf$/) == null) {
    $(window).on('unload', window_unfocused);
    $(window).on("focus", window_focused);
    $(window).on("blur", window_unfocused);

    $(document).ready(function() {
	    store_pwd_elements();

	    var message = {};
	    message.type = "query_status";
	    message.url = document.domain;
	    self.port.emit("query_status", message);
	});


    $(window).on("click.do_i_have_focus", function() {
	    $(window).off("click.do_i_have_focus");
	    window_focused(undefined);
	});

    $(window).on("keypress.do_i_have_focus", function() {
	    $(window).off("keypress.do_i_have_focus");
	    window_focused(undefined);
	});

    //Every 5 minutes, check if user is actually looking at the site actively.
    //Otherwise, count it as focus not checked.
    //This could create problems for sites like youtube or video sites.
    //Need to check somehow if Flash is active on the current site.
    setInterval(focus_check, 300 * 1000);

    self.port.emit("am_i_active", {}); 


    $(window).on("load", function() {
	    var message = {};
	    message.type = "am_i_active";
	});
    
    function register_message_listeners() {
	self.port.on("report-reminder", function(message) {
		show_report_ready_modal_dialog();
	    });
	self.port.on("status-enabled", function(message) {
		my_log("Here here, got message status-enabled", new Error);
		my_log("APPU DEBUG: status-enabled", new Error);
		is_appu_active = true;
		show_appu_monitor_icon();
		update_status('Appu is enabled');
	    });
	self.port.on("status-disabled", function(message) {
		my_log("Here here, got message status-disabled", new Error);
		my_log("APPU DEBUG: status-disabled", new Error);
		is_appu_active = false;
		hide_appu_monitor_icon();
		update_status('Appu is disabled');
	    });

	self.port.on("you_are_active", function(message) {
		window_focused();
	    });

	self.port.on("close-report-reminder", function(message) {
		close_report_ready_modal_dialog();
	    });
	self.port.on("goto-url", function(message) {
		window.location = message.url;
	    });
	self.port.on("simulate-click", function(message) {
		var element_to_click = apply_css_filter(apply_css_selector($(document), message.css_selector), 
							message.css_filter);
		
		var detect_change_css = message.detect_change_css;  
		
		//Hard timeout
		//Wait for 60 seconds before sending event that click cannot be 
		//completed.
		var simulate_done_timer = window.setTimeout(function() {
			var message = {};
			message.type = "simulate_click_done";
			self.port.emit("simulate_click_done", message);
		    }, 60 * 1000);
		
		
		MutationObserver = window.MutationObserver || window.WebKitMutationObserver;
		
		var observer = new MutationObserver(function(mutations, observer) {
			simulate_click_worked(mutations, observer, simulate_done_timer, detect_change_css);
		    });
		
		//var config = { attributes: true, childList: true, characterData: true }
		var config = { subtree: true, characterData: true, childList: true, attributes: true }
		observer.observe(document, config);
		
		//Now do the actual click
		$(element_to_click).trigger("click");
	    });

	self.port.on("get-html", function(message) {
		//Adding 2 seconds delay because some sites like Google+ have data populated asynchronously.
		//So the page loads but actual data is populated later.
		window.setTimeout(function() {
			var html_data = $("html").html();
			self.port.emit("get-html-response", {
				'type' : "get-html-response",
				    'data' : html_data
			    });
		    }, 2000);
		return true;
	    });

	self.port.on("get-permission-to-fetch-pi", function(message) {
		get_permission_to_fetch_pi(message.site);
		return true;
	    });

	self.port.on("check_passwd_reuse", function(message) {
		my_log("Here here: Domain: " + message.domain + ", Passwd: " + message.passwd, new Error);
	    });

	self.port.on("query_status_response", is_status_active);

	self.port.on("check_blacklist_response", is_blacklisted);

	self.port.on("am_i_active_response", function (r) {
		if (r.am_i_active) {
		    window_focused(undefined);
		    data_dir_url = r.data_dir_url;
		}
	    });

	self.port.on("check_pending_warnings_response", show_pending_warnings_async);
    }

    register_message_listeners();
}


