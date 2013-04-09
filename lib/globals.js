
exports.global_var = {
    ext_id : '',

    pii_vault : { "options" : {}, "config": {}},

    pending_warnings : {},
    pending_pi_fetch : {},

    //If user says remind me later
    report_reminder_interval : 30,

    //Report check interval in minutes
    report_check_interval : 5,

    //Do background tasks like send undelivered reports,
    //feedbacks etc
    bg_tasks_interval : 10,

    //Is user processing report?
    is_report_tab_open : 0,

    //All open report pages. These are useful to send updates to stats
    report_tab_ids : [],

    // Which text report to be shown in which tab-id
    text_report_tab_ids : {},

    //All open "My footprint" pages. These are useful to send updates to stats
    myfootprint_tab_ids : [],

    template_processing_tabs : {},

    //Was an undelivered report attempted to be sent in last-24 hours?
    delivery_attempts : {},

    //Keep server updated about my alive status
    last_server_contact : undefined,

    tld : undefined,
    focused_tabs : 0,

    current_user : "default",
    default_user_guid : "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",


    sign_in_status : "not-signed-in",

    fpi_metadata : {},

    //hashing workers
    //To keep track of background "Web workers" that are
    //asynchronously hashing passwords for you .. a million times.
    hashing_workers : {},

    environ : {},

    test_value : { 
	'options' : {},
    },
}
