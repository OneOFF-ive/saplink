import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Offline bridge checks; needs the same JCo JAR as the bridge, never connects to SAP. */
public final class SapLinkRfcBridgeRouterTest {
    public static void main(String[] args) throws Exception {
        Class<?> bridge = Class.forName("SapLinkRfcBridge");
        Method valid = bridge.getDeclaredMethod("validRouter", String.class);
        Method properties = bridge.getDeclaredMethod("connectionProperties", Properties.class, String[].class);
        valid.setAccessible(true); properties.setAccessible(true);
        for (String route : new String[] { "", "/H/router.example/S/3299", "/H/router/H/inner/S/saprouter" }) {
            if (!((Boolean)valid.invoke(null, route))) throw new AssertionError("Valid route rejected");
            Properties destination = new Properties();
            String[] fields = { "INIT", "sap.internal", "00", "001", "TEST", "synthetic-secret", "EN", "editor", "0", route };
            for (int i = 1; i < fields.length; i++) fields[i] = Base64.getEncoder().encodeToString(fields[i].getBytes(StandardCharsets.UTF_8));
            properties.invoke(null, destination, fields);
            if (!"sap.internal".equals(destination.getProperty("jco.client.ashost"))) throw new AssertionError("Target changed");
            if (route.isEmpty() ? destination.containsKey("jco.client.saprouter") : !route.equals(destination.getProperty("jco.client.saprouter")))
                throw new AssertionError("Router property mismatch");
            Properties legacy = new Properties();
            properties.invoke(null, legacy, Arrays.copyOf(fields, 9));
            if (legacy.containsKey("jco.client.saprouter")) throw new AssertionError("Legacy direct connection changed");
        }
        for (String route : new String[] { "/H/router/P/secret", "/H/router/W/secret", "/H/router/K/snc", "/H/router/S/0",
            "/H/router/S/65536", "/H/router\n/H/inner", "/H/", "http://router", "/H/user:secret@host" }) {
            if (((Boolean)valid.invoke(null, route))) throw new AssertionError("Invalid route accepted");
        }
        System.out.println("SAProuter bridge validation and destination mapping passed (offline)");
    }
}
