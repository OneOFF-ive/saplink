import com.sap.conn.jco.*;
import com.sap.conn.jco.ext.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.net.URI;
import java.util.*;

/** Private pipe transport for ADT only. This process owns one thread/context. */
public final class SapLinkRfcBridge {
    private static final String DESTINATION = "saplink-adt";
    private static final int MAX_INPUT = 4 * 1024 * 1024;
    private static byte[] decode(String value) { return Base64.getDecoder().decode(value); }
    private static String text(String value) { return new String(decode(value), StandardCharsets.UTF_8); }
    private static String encode(byte[] value) { return Base64.getEncoder().encodeToString(value); }
    private static boolean validRouter(String route) {
        if (route.isEmpty()) return true;
        if (route.length() > 2048 || !route.matches("(?:/H/[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?:/S/[A-Za-z0-9][A-Za-z0-9._-]{0,31})?){1,8}")) return false;
        java.util.regex.Matcher services = java.util.regex.Pattern.compile("/S/([^/]+)").matcher(route);
        while (services.find()) {
            String service = services.group(1);
            if (service.matches("[0-9]+")) {
                try { int port = Integer.parseInt(service); if (port < 1 || port > 65535) return false; }
                catch (NumberFormatException error) { return false; }
            }
        }
        return true;
    }
    private static void connectionProperties(Properties properties, String[] fields) throws IOException {
        String[] keys = { "jco.client.ashost", "jco.client.sysnr", "jco.client.client", "jco.client.user", "jco.client.passwd", "jco.client.lang" };
        for (int i = 0; i < keys.length; i++) properties.setProperty(keys[i], text(fields[i + 1]));
        String router = fields.length == 10 ? text(fields[9]) : "";
        if (!validRouter(router)) throw new IOException("ROUTER");
        if (!router.isEmpty()) properties.setProperty("jco.client.saprouter", router);
    }
    private static String line(Reader input) throws IOException {
        StringBuilder result = new StringBuilder();
        for (int c; (c = input.read()) != -1;) {
            if (c == '\n') return result.toString();
            if (result.length() >= MAX_INPUT) throw new IOException("INPUT_LIMIT");
            result.append((char)c);
        }
        return result.length() == 0 ? null : result.toString();
    }
    private static boolean permitted(String method, String uri, String role, boolean writes) throws Exception {
        URI parsed = new URI(uri);
        if (parsed.isAbsolute() || parsed.getRawAuthority() != null || parsed.getRawFragment() != null) return false;
        String path = parsed.getPath();
        if (path == null || !path.startsWith("/sap/bc/adt/") || path.contains("\\") || path.contains("%")) return false;
        for (String part : path.split("/")) if (part.equals(".") || part.equals("..")) return false;
        for (int i = 0; i < path.length(); i++) if (path.charAt(i) <= 32 || path.charAt(i) == 127) return false;
        if (method.equals("GET")) return true;
        if (!method.equals("POST") && !method.equals("PUT")) return false;
        boolean readPost = method.equals("POST") && Arrays.asList("/sap/bc/adt/checkruns", "/sap/bc/adt/datapreview/ddic",
            "/sap/bc/adt/datapreview/freestyle", "/sap/bc/adt/ddic/elementinfo", "/sap/bc/adt/cts/transportchecks",
            "/sap/bc/adt/repository/nodestructure", "/sap/bc/adt/navigation/target",
            "/sap/bc/adt/repository/informationsystem/usageReferences", "/sap/bc/adt/repository/informationsystem/usageSnippets",
            "/sap/bc/adt/abapsource/typehierarchy").contains(path);
        return readPost || (writes && !role.equals("reader"));
    }
    public static void main(String[] args) {
        if (args.length == 1 && args[0].equals("--check-runtime")) {
            try {
                System.loadLibrary("sapjco3");
                JCo.createRecordMetaData("SAPLINK_RUNTIME_CHECK");
                System.out.println("RFC_ENV\t1\t" + encode(System.getProperty("java.version").getBytes(StandardCharsets.UTF_8))
                    + "\t" + encode(System.getProperty("os.arch").getBytes(StandardCharsets.UTF_8))
                    + "\t" + encode(JCo.getVersion().getBytes(StandardCharsets.UTF_8)));
            } catch (Throwable error) { System.out.println("RFC_ENV_ERROR\tLOAD_FAILED"); System.exit(1); }
            return;
        }
        Properties properties = new Properties();
        DestinationDataProvider provider = null;
        JCoDestination destination = null;
        boolean stateful = false;
        boolean clean = false;
        try {
            Reader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String init = line(input);
            if (init == null) return;
            String[] fields = init.split("\t", -1);
            if ((fields.length != 9 && fields.length != 10) || !fields[0].equals("INIT")) throw new IOException("PROTOCOL");
            String role = text(fields[7]);
            if (!Arrays.asList("editor", "reader", "quality").contains(role)) throw new IOException("ROLE");
            boolean writes = text(fields[8]).equals("1");
            connectionProperties(properties, fields);
            properties.setProperty("jco.client.trace", "0");
            properties.setProperty("jco.destination.pool_capacity", "0");
            properties.setProperty("jco.destination.peak_limit", "1");
            provider = new DestinationDataProvider() {
                public Properties getDestinationProperties(String name) { return name.equals(DESTINATION) ? properties : null; }
                public void setDestinationDataEventListener(DestinationDataEventListener listener) { }
                public boolean supportsEvents() { return false; }
            };
            Environment.registerDestinationDataProvider(provider);
            destination = JCoDestinationManager.getDestination(DESTINATION);
            if (!role.equals("reader")) { JCoContext.begin(destination); stateful = true; }
            System.out.println("READY\t1");
            String command;
            while ((command = line(input)) != null) {
                if (command.equals("CLOSE")) break;
                String[] request = command.split("\t", -1);
                if (request.length != 5 || !request[0].matches("[0-9]+")) throw new IOException("PROTOCOL");
                String method = text(request[1]), uri = text(request[2]);
                if (uri.length() > 32768 || !permitted(method, uri, role, writes)) throw new IOException("POLICY");
                byte[] body = decode(request[4]);
                String headerText = text(request[3]);
                if (body.length > 2 * 1024 * 1024 || headerText.length() > 65536) throw new IOException("REQUEST_LIMIT");
                try {
                    JCoFunction function = destination.getRepository().getFunction("SADT_REST_RFC_ENDPOINT");
                    if (function == null) throw new IOException("ENDPOINT_MISSING");
                    JCoStructure rest = function.getImportParameterList().getStructure("REQUEST");
                    JCoStructure requestLine = rest.getStructure("REQUEST_LINE");
                    requestLine.setValue("METHOD", method); requestLine.setValue("URI", uri); requestLine.setValue("VERSION", "HTTP/1.1");
                    JCoTable headers = rest.getTable("HEADER_FIELDS");
                    for (String header : headerText.split("\n")) {
                        int split = header.indexOf(':');
                        if (split < 1) continue;
                        String name = header.substring(0, split), value = header.substring(split + 1);
                        if (!name.matches("[A-Za-z0-9!#$%&'*+.^_`|~-]+") || value.contains("\r") || value.contains("\0")) throw new IOException("HEADER");
                        if (Arrays.asList("authorization", "cookie", "x-csrf-token").contains(name.toLowerCase(Locale.ROOT))) continue;
                        headers.appendRow(); headers.setValue("NAME", name); headers.setValue("VALUE", value.trim());
                    }
                    rest.setValue("MESSAGE_BODY", body);
                    function.execute(destination);
                    JCoStructure response = function.getExportParameterList().getStructure("RESPONSE");
                    String status = response.getStructure("STATUS_LINE").getString("STATUS_CODE").trim();
                    if (!status.matches("[1-5][0-9]{2}")) throw new IOException("STATUS");
                    byte[] responseBody = response.getByteArray("MESSAGE_BODY");
                    if (responseBody.length > 16 * 1024 * 1024) throw new IOException("RESPONSE_LIMIT");
                    JCoTable responseHeaders = response.getTable("HEADER_FIELDS");
                    StringBuilder responseText = new StringBuilder();
                    for (int row = 0; row < responseHeaders.getNumRows(); row++) {
                        responseHeaders.setRow(row);
                        String name = responseHeaders.getString("NAME"), value = responseHeaders.getString("VALUE");
                        if (Arrays.asList("set-cookie", "cookie", "authorization", "x-csrf-token").contains(name.toLowerCase(Locale.ROOT))) continue;
                        if (value.contains("\r") || value.contains("\n")) throw new IOException("HEADER");
                        responseText.append(name).append(':').append(value).append('\n');
                        if (responseText.length() > 65536) throw new IOException("HEADER_LIMIT");
                    }
                    System.out.println(request[0] + "\tOK\t" + status + "\t"
                        + encode(responseText.toString().getBytes(StandardCharsets.UTF_8)) + "\t" + encode(responseBody));
                } catch (JCoException error) {
                    // Only the documented numeric error group crosses the pipe, never the SDK message.
                    System.out.println(request[0] + "\tERROR\t" + error.getGroup());
                    throw new IOException("CONTEXT_LOST");
                }
            }
            if (stateful) { JCoContext.end(destination); stateful = false; }
            clean = true;
            System.out.println("CLOSED");
        } catch (Throwable error) {
            System.out.println("FATAL");
        } finally {
            if (stateful && destination != null) try { JCoContext.end(destination); } catch (Throwable ignored) { }
            properties.clear();
            if (provider != null) try { Environment.unregisterDestinationDataProvider(provider); } catch (Throwable ignored) { }
        }
        if (!clean) System.exit(1);
    }
}
