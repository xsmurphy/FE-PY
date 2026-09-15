import net.sf.jasperreports.engine.*;
import net.sf.jasperreports.engine.print.*;
import net.sf.jasperreports.engine.util.JRLoader;
import net.sf.jasperreports.engine.util.JRXmlUtils;
import net.sf.jasperreports.engine.query.JRXPathQueryExecuterFactory;
import org.w3c.dom.Document;
import java.io.File;
import java.util.*;

/** Llena un template con un XML y lista todo texto que Jasper truncó. */
public class Audit {
  static void walk(List<JRPrintElement> els, List<String> out) {
    for (JRPrintElement e : els) {
      if (e instanceof JRPrintFrame) walk(((JRPrintFrame) e).getElements(), out);
      if (e instanceof JRPrintText) {
        JRPrintText t = (JRPrintText) e;
        Integer idx = t.getTextTruncateIndex();
        String full = t.getOriginalText() != null ? t.getOriginalText() : t.getFullText();
        if (idx != null && full != null && idx < full.length()) {
          out.add("TRUNCADO w=" + e.getWidth() + " [" + full.substring(0, idx) + "] se pierde [" + full.substring(idx) + "]");
        }
      }
    }
  }
  public static void main(String[] a) throws Exception {
    // Sin esto Jasper descarta el texto recortado y no hay forma de saber qué se perdió.
    net.sf.jasperreports.engine.DefaultJasperReportsContext.getInstance().setProperty("net.sf.jasperreports.print.keep.full.text", "true");
    JasperReport r = (JasperReport) JRLoader.loadObject(new File(a[0]));
    Document doc = JRXmlUtils.parse(new File(a[1]));
    Map<String, Object> p = new HashMap<>();
    p.put(JRXPathQueryExecuterFactory.PARAMETER_XML_DATA_DOCUMENT, doc);
    p.put("ambiente", "2");
    p.put("SUBREPORT_DIR", new File(a[0]).getParent() + "/");
    JasperPrint jp = JasperFillManager.fillReport(r, p);
    List<String> out = new ArrayList<>();
    for (JRPrintPage pg : jp.getPages()) walk(pg.getElements(), out);
    System.out.println("== " + new File(a[0]).getName() + " páginas=" + jp.getPages().size() + " truncados=" + out.size());
    out.forEach(System.out::println);
  }
}
