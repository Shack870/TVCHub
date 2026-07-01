/**
 * TVCHub — Gmail intake bridge
 * ------------------------------------------------------------------
 * Runs INSIDE the intake@ironrocklaw.com mailbox (Google Apps Script).
 * On a time trigger it finds new TVC referral emails and posts them to the
 * TVCHub Cloud Function, which parses them and drops a new card on the desk.
 *
 * SETUP (do this once, signed in as intake@ironrocklaw.com):
 *  1. Go to https://script.google.com  ->  New project
 *  2. Delete the sample code, paste this whole file, Save.
 *  3. Project Settings (gear icon) -> Script Properties -> add two properties:
 *       FUNCTION_URL  = the deployed ingestEmail URL
 *                       (e.g. https://us-central1-tvchub-f2401.cloudfunctions.net/ingestEmail)
 *       INGEST_TOKEN  = the shared secret (must match the Firebase
 *                       `INGEST_TOKEN` function secret exactly)
 *  4. Run the function `authorizeOnce` (top toolbar) and approve the
 *     Gmail + external-request permissions when prompted.
 *  5. Run `checkSetup` to confirm the URL + token reach the function
 *     (look for "Config OK" in the execution log).
 *  6. Run `installTrigger` once to start checking every minute.
 *  That's it. New TVC emails will appear on the desk automatically.
 *
 *  OPTIONAL — on-demand "Check for new leads" button in the app:
 *  7. Add a Script Property CHECK_TOKEN = any long random string.
 *  8. Deploy -> New deployment -> Web app: "Execute as: me",
 *     "Who has access: Anyone". Copy the /exec URL.
 *  9. In the app's .env.local set:
 *       VITE_INBOX_CHECK_URL   = that /exec URL
 *       VITE_INBOX_CHECK_TOKEN = the same CHECK_TOKEN value
 *     then rebuild/redeploy hosting.
 *
 * The URL and token are read from Script Properties (never hardcoded here) so
 * the secret stays out of source control. To re-import an email you already
 * processed, remove the "TVC-Ingested" label from its thread in Gmail.
 */

// ---- Configuration (read from Script Properties — see SETUP step 3) ----
function getConfig_() {
  var props = PropertiesService.getScriptProperties();
  var functionUrl = props.getProperty('FUNCTION_URL');
  var ingestToken = props.getProperty('INGEST_TOKEN');
  if (!functionUrl || !ingestToken) {
    throw new Error(
      'Missing Script Properties. Set FUNCTION_URL and INGEST_TOKEN in ' +
        'Project Settings -> Script Properties (see SETUP step 3).',
    );
  }
  // Optional separate secret for the on-demand "check now" web endpoint, so the
  // app can trigger a scan without ever exposing INGEST_TOKEN in the browser.
  var checkToken = props.getProperty('CHECK_TOKEN');
  return { functionUrl: functionUrl, ingestToken: ingestToken, checkToken: checkToken };
}

/**
 * On-demand trigger for the "Check for new leads" button in TVCHub.
 * Deploy this script as a Web App (Deploy -> New deployment -> Web app,
 * "Execute as: me", "Who has access: Anyone"), then put:
 *   - the /exec URL in the app's VITE_INBOX_CHECK_URL
 *   - a CHECK_TOKEN Script Property in both here and VITE_INBOX_CHECK_TOKEN
 * The app calls this URL to scan the inbox immediately instead of waiting for
 * the every-minute trigger.
 */
function doGet(e) {
  var config = getConfig_();
  var token = e && e.parameter ? e.parameter.token : '';
  if (!config.checkToken || token !== config.checkToken) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: 'unauthorized' }),
    ).setMimeType(ContentService.MimeType.JSON);
  }
  var ran = 0;
  try {
    ran = checkInbox();
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) }),
    ).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, ran: ran }),
  ).setMimeType(ContentService.MimeType.JSON);
}

// Gmail search for new referrals (last 7 days, not yet ingested). Matches
// either a "TVC" subject OR anything from the TVC sender domain (e.g.
// tvc@prodriver.com), since some are forwarded with generic subjects.
var SEARCH_QUERY =
  '(subject:TVC OR from:prodriver.com) -label:TVC-Ingested newer_than:7d';
var DONE_LABEL = 'TVC-Ingested';

/** Main poller — called by the time trigger. */
function checkInbox() {
  try {
    var result = scanAndPost_(SEARCH_QUERY);
    if (result.retries > 0) {
      recordFailure_('Ingest returned retry for ' + result.retries + ' message(s)');
    } else {
      recordSuccess_();
    }
    return result.ingested;
  } catch (err) {
    recordFailure_('checkInbox threw: ' + err);
    throw err;
  }
}

// ---- Failure alerting -------------------------------------------------------
// A single transient failure fixes itself on the next minute's run, so only a
// STREAK of consecutive failing runs (~5 min of downtime) sends an email — and
// at most once every 6 hours. Set an ALERT_EMAIL Script Property to choose the
// recipient (defaults to this mailbox).

var FAIL_STREAK_THRESHOLD = 5;
var ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function recordSuccess_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FAIL_STREAK')) props.deleteProperty('FAIL_STREAK');
}

function recordFailure_(detail) {
  var props = PropertiesService.getScriptProperties();
  var streak = Number(props.getProperty('FAIL_STREAK') || '0') + 1;
  props.setProperty('FAIL_STREAK', String(streak));
  Logger.log('Failure streak %s: %s', streak, detail);
  if (streak < FAIL_STREAK_THRESHOLD) return;

  var lastAlert = Number(props.getProperty('LAST_ALERT_AT') || '0');
  if (Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;
  props.setProperty('LAST_ALERT_AT', String(Date.now()));

  var to =
    props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(
    to,
    '[TVCHub] Lead ingestion is failing',
    'The Gmail lead pipeline has failed ' + streak + ' runs in a row.\n\n' +
      'Latest error: ' + detail + '\n\n' +
      'New TVC referrals are NOT reaching the board. Check:\n' +
      '  1. script.google.com -> Executions for error details\n' +
      '  2. OpenAI status/quota (extraction errors return retry)\n' +
      '  3. Firebase console -> Functions -> ingestEmail logs\n\n' +
      'Unprocessed emails stay unlabeled and will import automatically ' +
      'once the pipeline recovers.',
  );
  Logger.log('Alert email sent to %s', to);
}

/**
 * One-off recovery: re-scan the last 7 days of TVC emails IGNORING the
 * TVC-Ingested label. Safe to run anytime — the Cloud Function de-dupes by
 * Gmail message id and TVC case number, so already-imported leads are skipped.
 * Use this after an AI/quota outage to recover emails that got labeled "done"
 * but never actually imported.
 */
function rescanRecent() {
  return scanAndPost_('(subject:TVC OR from:prodriver.com) newer_than:7d');
}

/**
 * Search Gmail with `query` and post EVERY TVC message of each matching thread.
 *
 * Gmail groups messages that share a subject into one conversation, so a single
 * thread can hold multiple distinct referrals. The old code posted only the
 * first message and labeled the whole thread done, silently dropping the rest.
 * We now post every matching message; the Cloud Function dedups by message id /
 * case number / identity, so re-sends are cheap no-ops. The thread is labeled
 * (which stops us re-uploading its attachments every minute) only once every
 * matching message reached a permanent result — a transient failure leaves it
 * unlabeled so the next run retries.
 */
function scanAndPost_(query) {
  var config = getConfig_();
  var label = getOrCreateLabel_(DONE_LABEL);
  var threads = GmailApp.search(query, 0, 50);
  Logger.log('Running as: %s', Session.getEffectiveUser().getEmail());
  Logger.log('Query: %s', query);
  Logger.log('Matched %s thread(s).', threads.length);
  var ingested = 0;
  var retries = 0;

  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    var allHandled = true; // false if any matching message needs a retry
    var sawMatch = false;

    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      var subject = msg.getSubject() || '';
      var from = msg.getFrom() || '';
      // A TVC referral: "TVC" in the subject OR from the TVC sender domain
      // (e.g. tvc@prodriver.com) for forwards with generic subjects.
      if (!/\bTVC\b/i.test(subject) && !/@prodriver\.com/i.test(from)) continue;
      sawMatch = true;

      var status = postMessage_(config, msg, subject, from);
      if (status === 'created') ingested++;
      else if (status === 'retry') {
        retries++;
        allHandled = false;
      }
    }

    // Label threads with no matching message too, so we never rescan them.
    if (allHandled || !sawMatch) thread.addLabel(label);
  });

  return { ingested: ingested, retries: retries };
}

/**
 * Post one Gmail message to the ingest function.
 * Returns 'created' (new lead), 'permanent' (deduped/merged/skipped/review), or
 * 'retry' (transient failure — caller should leave the thread unlabeled).
 */
function postMessage_(config, msg, subject, from) {
  var attachments = [];
  var atts = msg.getAttachments({
    includeInlineImages: false,
    includeAttachments: true,
  });
  var total = 0;
  for (var a = 0; a < atts.length; a++) {
    var blob = atts[a];
    var size = blob.getSize();
    if (size > 20 * 1024 * 1024) continue; // skip huge files
    total += size;
    if (total > 28 * 1024 * 1024) break; // keep request under limit
    attachments.push({
      name: blob.getName(),
      contentType: blob.getContentType(),
      dataB64: Utilities.base64Encode(blob.getBytes()),
    });
  }

  var payload = {
    token: config.ingestToken,
    messageId: msg.getId(),
    subject: subject,
    from: from,
    plainBody: msg.getPlainBody(),
    htmlBody: msg.getBody(),
    receivedAt: msg.getDate().getTime(),
    attachments: attachments,
  };

  try {
    var res = UrlFetchApp.fetch(config.functionUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });
    var text = res.getContentText();
    Logger.log('%s -> %s', subject, text);
    var json = {};
    try { json = JSON.parse(text); } catch (e2) {}
    // Transient failure (e.g. AI quota) returns retry:true / non-200.
    if (res.getResponseCode() !== 200 || json.retry) return 'retry';
    // A brand-new lead has an id with no skipped/merged/updated/review flag.
    if (json.id && !json.skipped && !json.merged && !json.updated && !json.needsReview) {
      return 'created';
    }
    return 'permanent';
  } catch (e) {
    Logger.log('Error posting "%s": %s', subject, e);
    return 'retry';
  }
}

/** Run once to grant permissions. */
function authorizeOnce() {
  var config = getConfig_();
  GmailApp.getInboxThreads(0, 1);
  UrlFetchApp.fetch(config.functionUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ token: 'probe' }),
    muteHttpExceptions: true,
  });
  Logger.log('Authorized. Now run installTrigger().');
}

/**
 * Run once after setting Script Properties to confirm the function URL and
 * token are correct — without touching the inbox. Posts a tokened probe (no
 * TVC subject) and reports the result:
 *   - "Config OK"        -> URL + token are good, safe to installTrigger().
 *   - "Bad token (401)"  -> INGEST_TOKEN doesn't match the Firebase secret.
 *   - anything else      -> check FUNCTION_URL / that the function is deployed.
 */
function checkSetup() {
  var config = getConfig_();
  var res = UrlFetchApp.fetch(config.functionUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ token: config.ingestToken, subject: 'setup probe' }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var body = res.getContentText();
  if (code === 200) {
    Logger.log('Config OK — URL and token reach the function. Response: %s', body);
  } else if (code === 401) {
    Logger.log('Bad token (401) — INGEST_TOKEN does not match the Firebase secret.');
  } else {
    Logger.log(
      'Unexpected response %s — check FUNCTION_URL and that ingestEmail is deployed. Body: %s',
      code,
      body,
    );
  }
}

/** Run once to schedule checkInbox() every minute. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkInbox').timeBased().everyMinutes(1).create();
  Logger.log('Trigger installed: checkInbox runs every minute.');
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}
