package md.incept.selfforming

import org.json.JSONObject
import java.util.UUID

/** core-execution's bridge routes (R1): env.* through the ExecutionService, one client per document. */
internal object CoreExecutionNative : BuiltinNative {
    override fun capabilities(into: JSONObject) {
        into.put("executionEnv", true).put("shell", "ubuntu-proot").put("backgroundExecution", true)
    }

    override fun attach(scope: BridgeScope): BridgeRoutes = object : BridgeRoutes {
        private var client = UUID.randomUUID().toString()
        override fun handles(method: String) = method.startsWith("env.")
        override fun dispatch(call: BridgeCall) {
            if (call.method == "env.exec") scope.executionStarted()
            ExecutionService.dispatch(scope.context, client, call.method, call.params, call.done, call.fail, call.event)
        }
        override fun reset() {
            ExecutionService.detach(client)
            client = UUID.randomUUID().toString()
        }
    }
}
