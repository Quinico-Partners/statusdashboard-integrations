(function executeRule(current, previous /*null when async*/) {

    /*
     
      StatusDashboard ServiceNow business rule integration script
      Copyright (c) Quinico Partners, LLC

    */
  
    // ------------------------------------------------------------------------------------
    // ** CUSTOMER DEFINED SETTINGS **
    //

    // Set debug mode for troubleshooting
    var debug = true;
    
    // Define the StatusDashboard endpoint for the webhook
    var endpoint = ""; // Example: a183eb2c73db4e897002275aefc78826
    
    // Define the secret for signing. If signing is not used, leave this
    // value as an empty string.
    var secret = "";
    
    // Mapping between ServiceNow "State" and StatusDashboard "Status"
    var statusMapping = {
        "New": "investigating",
        "In Progress": "identified",
        "On Hold": "identified",
        "Resolved": "resolved",
        "Closed": "resolved",
        "Cancelled": "resolved"
    };
    
    // Whether or not to include severity in the webhook. If set to false, the severity
    // value will not be set on the event that is created/updated in StatusDashboard
    var severity_include = true;

    // Set to true if severity should be hidden from status dashboards and notifications
    // Severity can be set for internal tracking, but not displayed to customers by setting
    // this value to true.
    var severity_hide = false;

    // Mapping between ServiceNow "Impact" and StatusDashboard "Severity"
    // These values are not required to be set if 'severity_include" is set to false above.
    //
    // The StatusDashboard severity levels defined here must either be the standard values of
    // minor_performance|major_performance|minor_outage|major_outage
    // or custom severities (if enabled in the StatusDashboard event configuration)
    var severityMapping = {
        "1 - High": "High",    
        "2 - Medium": "Medium",
        "3 - Low": "Low"      
    };

    // Whether or not to include the longer description as well as the short description. If set to true
    // and the longer description field is populated, it will be concatenated onto the end of the short
    // description
    include_long_description = true;

    // Notifications can be suppressed for any webhook sent by including a special character sequence anywhere
    // in the short description. The presence of this character sequence will suppress notifications even if the 
    // StatusDashboard configuration is set to send them for inbound webhooks. This character sequence will be
    // removed from the description before the webhook is sent.
    // Customers may choose to develop an alternate method for notification suppression (i.e. a unique field on
    // the events table that can be checked by this business rule)
    suppress_str = "{-}";

    //
    // END CUSTOMER DEFINED SETTINGS **
    // ------------------------------------------------------------------------------------



    // Define the webhook payload that will be sent to StatusDashboard
    var payload = {
        id: current.sys_id.toString(),                      // Incident sys_id
        type: "incident",                                   // "incident is currently the only support event type"
        status: mapStatus(current.state.getDisplayValue()), // Map ServiceNow "State" to StatusDashboard "Status"
        services: getAffectedServices(),                    // Fetch affected services (as sys_ids)
        timeline: false,                                    // Prevent an 'investigating' timeline entry on new events
        severity_hide: severity_hide                        // Whether or not to hide severity in events and notifications
    };
    
    // Add the description to the webhook payload (short, or short + long)
    payload.description = getDescription()

    // Add severity to the webhook payload if requested
    if (severity_include) {
      payload.severity = mapSeverity(current.getDisplayValue('impact')); // Map ServiceNow "Impact" to StatusDashboard "Severity"
    }

    /* 
      ServiceNow customers can update incidents in ServiceNow in two ways that are meaningful to StatusDashboard
    
        1: Change the short description, or change another attribute like "State" or "Impact" or impacted services
        2: Add a "Customer visible" comment
    
        1 & 2 can be done at the same time and then the customer clicks the "Update" button which updates the incident
        and all of it's attributes, or they can just add a customer visible comment and click the "Post" button.

        If no customer visible comment is being made with this update, then there is no additional information to share
        with StatusDashboard customers, so do not add the "update" to the payload.

        If a customer visible comment is being added (either independently or with an incident update), then include the
        "update" attribute with the relevant last comment and mark it with a status of "update" in the StatusDashboard
        event timeline.

    */
    if (current.operation() === 'update') {
      // Add the "update" key to the payload
      logDebug("Incident update detected");

      // If there is an updated customer visible comment, then update accordingly
      // This will be sent as an 'update' status.
      if (current.comments.changes()) {

        // Add the update to the webhook payload.
        payload.update = {
          status: "update",
          update: "" // Empty string for now. This will be populated if we have a comment
        };

        // Fetch customer visible comments (the most recent one)
        var lastComment = current.comments.getJournalEntry(1);

        // Check if there is a comment and split out unnecessary text
        if (lastComment) {
            logDebug("A customer visible comment exist on this incident: " + lastComment);
            // Capture everything after the first \n
            var splitComment = lastComment.split('\n'); // Split by newline
            if (splitComment.length > 1) {
              lastComment = splitComment.slice(1).join('\n'); // Join back everything after the first newline
            }

            // Remove any trailing newlines (including the last two if they exist)
            lastComment = lastComment.replace(/(\n\s*){2,}$/, ''); // Remove trailing newlines
            
            // Set the last comment in the payload if it exists
            logDebug("Last customer visible comment (cleaned) on this incident: " + lastComment);
            payload.update.update = lastComment; // Assign last comment to the payload
        } else {
          // Since we don't have a comment to add, do not add the update to the payload.
          logDebug("Changes detected to the incident comments field but could not acquire the last comment");
        }
      } else {
        // This is an update to the incident without any customer visible comments, so do
        // not include the update attribute in the webhook payload
        logDebug("Incident update detected with no customer visible comments");
      }
    } else {
      // Nothing to do here with respect to the update attribute
      logDebug("New incident detected");
    }

    // Map ServiceNow state to StatusDashboard status
    function mapStatus(serviceNowState) {
      logDebug("ServiceNow severity:" + serviceNowState);
      return statusMapping[serviceNowState] || "unknown"; // If unknown, StatusDashboard will reject the webhook
    }

    // Map ServiceNow impact to StatusDashboard severity
    function mapSeverity(serviceNowImpact) {
      logDebug("ServiceNow impact:" + serviceNowImpact);
      return severityMapping[serviceNowImpact] || "unknown"; // If unknown, StatusDashboard will reject the webhook
    }

    // Get the incident description
    function getDescription() {
      var shortDescription = current.short_description.toString();  // Required field so we know it is there.
      var longDescription = current.description ? current.description.toString() : ""; // Handle if long description is null or empty
      
      // Check if the suppress string is present, and remove it from the short description if found
      if (shortDescription.includes(suppress_str)) {
        shortDescription = shortDescription.replace(suppress_str, "").trim(); // Remove the suppress string and trim any extra spaces
        payload["suppress_notif"] = true; // Set the suppress_notif attribute in the payload
      }

      if (include_long_description && longDescription) {
          // Concatenate short and long descriptions with a separator
          // Assume there is a period after the short description, so we put a space after it and
          // then start the long description.
          return shortDescription + " " + longDescription;
      } else {
          // Return only the short description
          return shortDescription;
      }
    }

    // Fetch all services affected by this incident
    function getAffectedServices() {
      var services = new Set(); // Use a Set to avoid duplicates

      // Get the primary business service (sys_id)
      if (current.business_service) {
        logDebug("Found incident primary business service:" + current.business_service.getDisplayValue());
        services.add(current.business_service.toString()); // Add business_service sys_id
      }

      // Query the task_cmdb_ci_service table for all affected CIs linked to this incident
      // "Impacted Services/CIs"
      var taskCIServicesGR = new GlideRecord('task_cmdb_ci_service');
      taskCIServicesGR.addQuery('task', current.sys_id); // Link to the incident sys_id
      taskCIServicesGR.query();
      while (taskCIServicesGR.next()) {
        logDebug("Found incident Impacted Service/CI:" + taskCIServicesGR.cmdb_ci_service.getDisplayValue());
        services.add(taskCIServicesGR.cmdb_ci_service.toString()); // Add the cmdb_ci_service sys_id
      }

      return Array.from(services); // Convert Set back to array before returning
    }

    // Generate a webhook signature if the secret is set
    function getSignature(callback) {
      if (secret) {
        var signatureUrl = 'https://www.statusdashboard.com/webhooks/integration/' + endpoint + '/signature';
        var request = new sn_ws.RESTMessageV2();
        request.setEndpoint(signatureUrl);
        request.setHttpMethod('POST');
        request.setRequestHeader('x-statusdashboard-secret', secret);

        // Convert the payload to JSON for the signature calculation
        var jsonString = JSON.stringify(payload);
        request.setRequestBody(jsonString); // Send the same payload for signature calculation

        // Send request to get the signature
        try {
          var response = request.execute();
          var httpResponseStatus = response.getStatusCode();
          var responseBody = response.getBody();
          // Handle HTTP 201 response status
            if (httpResponseStatus == 201) {
              var signature = JSON.parse(responseBody).signature;
              callback(null, signature); // Pass the signature to the callback
            } else {
              gs.error('Failed to retrieve webhook signature. Status: ' + httpResponseStatus);
              callback('Failed to retrieve signature');
            }
        } catch (ex) {
          gs.error('Error retrieving webhook signature: ' + ex.getMessage());
          callback('Error retrieving signature');
        }
      } else {
        callback(null, null); // No secret provided, so no signature
      }
    }

    // Send the webhook with or without the signature
    function sendWebhook(signature) {
      var webhookUrl = 'https://www.statusdashboard.com/webhooks/integration/' + endpoint + '/';

      var request = new sn_ws.RESTMessageV2();
      request.setEndpoint(webhookUrl);
      request.setHttpMethod('POST');
      request.setRequestHeader('Content-Type', 'application/json');

      // If a signature is provided, add it to the headers
      if (signature) {
        request.setRequestHeader('x-statusdashboard-signature', signature);
      }

      // Convert payload to JSON
      var jsonString = JSON.stringify(payload);

      // Set the request body
      request.setRequestBody(jsonString);

      // Send the request
      try {
        var response = request.execute();
        var httpResponseStatus = response.getStatusCode();
        var responseBody = response.getBody();
        gs.info('Webhook sent. Status: ' + httpResponseStatus + ' Response: ' + responseBody);
      } catch (ex) {
        gs.error('Error sending webhook: ' + ex.getMessage());
      }
    }

    // Logging function that logs if debug is enabled
    function logDebug(message) {
      if (debug) {
        gs.info(message); // This logs only when debug is true
      }
    }

    // Check if a secret is provided, then get the signature and send the webhook
    if (secret) {
      getSignature(function(err, signature) {
        if (!err) {
          sendWebhook(signature); // Send webhook with signature
        }
      });
    } else {
      sendWebhook(null); // Send webhook without signature
    }

})(current, previous);
