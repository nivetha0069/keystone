(function executeDotwalkersMara() {
    var runId = String(event.parm1 || '');
    var approvalEventId = String(event.parm2 || '');
    var service = new DotwalkersIreSimulationService();
    var claim;

    try {
        claim = service.validateAndClaimApprovalResume(runId, approvalEventId);
    } catch (ignoredValidationFailure) {
        gs.error('Dotwalkers Mara approval resume rejected safely.');
        return;
    }

    if (!claim || claim.success !== true || claim.claimed !== true) {
        gs.info('Dotwalkers Mara approval resume stopped: ' +
            (claim && claim.state ? claim.state : 'invalid_token'));
        return;
    }

    try {
        var prepared = new DotwalkersMaraAgent().prepareApprovalResume(claim.binding);
        if (!prepared || prepared.success !== true) {
            throw new Error('Preparation did not complete');
        }

        if (!service.recordApprovalResumePrepared(claim.binding, claim.claim_event_id)) {
            throw new Error('Prepared marker was not recorded');
        }
        gs.info('Dotwalkers Mara approval continuation prepared.');
    } catch (ignoredPreparationFailure) {
        try {
            service.recordApprovalResumeFailure(claim.binding, claim.claim_event_id);
        } catch (ignoredFailureRecording) {
            gs.error('Dotwalkers Mara preparation failed and its compact marker could not be recorded.');
            return;
        }
        gs.error('Dotwalkers Mara approval continuation preparation failed safely.');
        return;
    }

    try {
        var continuation = new DotwalkersMaraAgent().continueApprovalResume(prepared);
        if (!continuation || continuation.success !== true) {
            gs.error('Dotwalkers Mara Phase D continuation stopped safely.');
            return;
        }
        gs.info('Dotwalkers Mara Phase D continuation reached its terminal verification state.');
    } catch (ignoredContinuationFailure) {
        gs.error('Dotwalkers Mara Phase D continuation stopped safely.');
    }
})();
