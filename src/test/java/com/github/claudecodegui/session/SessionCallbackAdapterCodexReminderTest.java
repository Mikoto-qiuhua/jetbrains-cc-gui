package com.github.claudecodegui.session;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Verifies which Codex interactions should raise the user-input reminder toast. */
public class SessionCallbackAdapterCodexReminderTest {

    private static JsonObject parse(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    @Test
    public void requestUserInputAnnouncesReminder() {
        JsonObject event = parse("{\"kind\":\"interactionRequested\",\"interactionKey\":\"k1\","
                + "\"payload\":{\"method\":\"item/tool/requestUserInput\"}}");
        assertTrue(SessionCallbackAdapter.isCodexUserInputRequest(event));
    }

    @Test
    public void elicitationAnnouncesReminder() {
        JsonObject event = parse("{\"kind\":\"interactionRequested\",\"interactionKey\":\"k2\","
                + "\"payload\":{\"method\":\"mcpServer/elicitation/request\"}}");
        assertTrue(SessionCallbackAdapter.isCodexUserInputRequest(event));
    }

    @Test
    public void commandApprovalDoesNotAnnounceReminder() {
        JsonObject event = parse("{\"kind\":\"interactionRequested\",\"interactionKey\":\"k3\","
                + "\"payload\":{\"method\":\"item/commandExecution/requestApproval\"}}");
        assertFalse(SessionCallbackAdapter.isCodexUserInputRequest(event));
    }

    @Test
    public void resolvedRequestDoesNotAnnounceReminder() {
        JsonObject event = parse("{\"kind\":\"interactionRequested\",\"resolved\":true,"
                + "\"interactionKey\":\"k4\",\"payload\":{\"method\":\"item/tool/requestUserInput\"}}");
        assertFalse(SessionCallbackAdapter.isCodexUserInputRequest(event));
    }

    @Test
    public void otherKindsDoNotAnnounceReminder() {
        assertFalse(SessionCallbackAdapter.isCodexUserInputRequest(
                parse("{\"kind\":\"interactionResolved\",\"interactionKey\":\"k5\"}")));
        assertFalse(SessionCallbackAdapter.isCodexUserInputRequest(
                parse("{\"kind\":\"planUpdated\",\"payload\":{\"item\":{}}}")));
    }

    @Test
    public void missingPayloadOrEventIsIgnored() {
        assertFalse(SessionCallbackAdapter.isCodexUserInputRequest(
                parse("{\"kind\":\"interactionRequested\",\"interactionKey\":\"k6\"}")));
        assertFalse(SessionCallbackAdapter.isCodexUserInputRequest(null));
    }
}
