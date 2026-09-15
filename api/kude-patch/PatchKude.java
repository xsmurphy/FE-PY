import net.sf.jasperreports.engine.*;
import net.sf.jasperreports.engine.base.JRBaseStaticText;
import net.sf.jasperreports.engine.base.JRBaseTextField;
import net.sf.jasperreports.engine.type.TextAdjustEnum;
import net.sf.jasperreports.engine.util.JRLoader;
import net.sf.jasperreports.engine.util.JRSaver;
import java.io.File;
import java.util.*;

/**
 * Parche de los templates KUDE de facturacionelectronicapy-kude.
 *
 * Problema: todos los campos dinámicos vienen con textAdjust=CUT_TEXT y
 * anchos calculados para datos cortos y para las métricas de Helvetica. En
 * producción (DejaVu, más ancha) y con datos reales, el KUDE recortaba en
 * silencio datos con valor legal: los últimos 8 dígitos del CDC, el CDC del
 * documento asociado, montos, razón social, direcciones, descripción de
 * ítems.
 *
 * Arreglo: SCALE_FONT en todo campo dinámico. Solo achica la fuente cuando
 * el contenido NO entra en la caja; con datos que entran, el PDF queda
 * idéntico. No mueve ni agranda elementos, así que no puede pisar nada.
 *
 * Los textos estáticos no admiten textAdjust: se les reduce la fuente
 * explícitamente (lista cerrada, verificada con Audit).
 *
 * Solo toca atributos de layout; las expresiones compiladas quedan intactas
 * (el paquete no trae compilador de Jasper, no se puede recompilar).
 */
public class PatchKude {
  static int fields = 0;
  static List<String> statics = new ArrayList<>();

  // Etiquetas estáticas que Audit detectó recortadas con DejaVu, por template,
  // con el tamaño de fuente con el que entran completas (verificado con Audit).
  // Solo esas: achicar etiquetas que ya entran sería un cambio visual gratuito.
  static final Map<String, Map<String, Float>> STATIC_CUT = new HashMap<>();
  static {
    Map<String, Float> factura = new LinkedHashMap<>();
    factura.put("Consulte la validez", 7.5f);
    factura.put("Nº:", 6.8f);
    STATIC_CUT.put("Factura.jasper", factura);
    STATIC_CUT.put("AutoFactura.jasper", Collections.singletonMap("Consulte la validez", 7.2f));
    STATIC_CUT.put("NotaDeDebito.jasper", Collections.singletonMap("Tipo de cambio global o por", 5.95f));
  }
  static Map<String, Float> staticTargets = Collections.emptyMap();

  static void walk(JRElement[] els) {
    if (els == null) return;
    for (JRElement e : els) {
      if (e instanceof JRFrame) walk(((JRFrame) e).getElements());
      if (e instanceof JRBaseTextField) {
        JRBaseTextField tf = (JRBaseTextField) e;
        if (tf.getTextAdjust() == TextAdjustEnum.CUT_TEXT) {
          tf.setTextAdjust(TextAdjustEnum.SCALE_FONT);
          fields++;
        }
      } else if (e instanceof JRBaseStaticText) {
        JRBaseStaticText st = (JRBaseStaticText) e;
        String text = st.getText() == null ? "" : st.getText().trim();
        for (Map.Entry<String, Float> t : staticTargets.entrySet()) {
          if (text.startsWith(t.getKey())) {
            Float current = st.getFontsize();
            st.setFontSize(t.getValue());
            statics.add("'" + text + "' " + current + " -> " + st.getFontsize());
          }
        }
      }
    }
  }

  public static void main(String[] a) throws Exception {
    staticTargets = STATIC_CUT.getOrDefault(new File(a[0]).getName(), Collections.emptyMap());
    JasperReport r = (JasperReport) JRLoader.loadObject(new File(a[0]));
    List<JRBand> bands = new ArrayList<>();
    for (JRBand b : new JRBand[]{r.getTitle(), r.getPageHeader(), r.getColumnHeader(), r.getColumnFooter(),
        r.getPageFooter(), r.getLastPageFooter(), r.getSummary(), r.getBackground(), r.getNoData()}) {
      if (b != null) bands.add(b);
    }
    if (r.getDetailSection() != null && r.getDetailSection().getBands() != null) Collections.addAll(bands, r.getDetailSection().getBands());
    if (r.getGroups() != null) {
      for (JRGroup g : r.getGroups()) {
        for (JRSection sec : new JRSection[]{g.getGroupHeaderSection(), g.getGroupFooterSection()}) {
          if (sec != null && sec.getBands() != null) Collections.addAll(bands, sec.getBands());
        }
      }
    }
    for (JRBand b : bands) if (b != null) walk(b.getElements());
    JRSaver.saveObject(r, new File(a[1]));
    System.out.println("OK " + new File(a[1]).getName() + " campos=" + fields + " estaticos=" + statics);
  }
}
