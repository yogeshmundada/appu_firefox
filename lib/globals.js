
var global_var = {}
global_var.ext_id = '';

global_var.pii_vault = { "options" : {}, "config": {}};

global_var.pending_warnings = {};
global_var.pending_pi_fetch = {};

//If user says remind me later
global_var.report_reminder_interval = 30;

//Report check interval in minutes
global_var.report_check_interval = 5;

//Do background tasks like send undelivered reports,
//feedbacks etc
global_var.bg_tasks_interval = 10;

//Is user processing report?
global_var.is_report_tab_open = 0;

//All open report pages. These are useful to send updates to stats
global_var.report_tab_ids = [];

// Which text report to be shown in which tab-id
global_var.text_report_tab_ids = {};

//All open "My footprint" pages. These are useful to send updates to stats
global_var.myfootprint_tab_ids = [];

global_var.template_processing_tabs = {};

//Was an undelivered report attempted to be sent in last-24 hours?
global_var.delivery_attempts = {};

//Keep server updated about my alive status
global_var.last_server_contact = undefined;

global_var.tld = undefined;
global_var.focused_tabs = 0;

global_var.current_user = "default";
global_var.default_user_guid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";


global_var.sign_in_status = "not-signed-in";

global_var.fpi_metadata = {};

//hashing workers
//To keep track of background "Web workers" that are
//asynchronously hashing passwords for you .. a million times.
global_var.hashing_workers = {};

global_var.environ = {};

exports.global_var = global_var;