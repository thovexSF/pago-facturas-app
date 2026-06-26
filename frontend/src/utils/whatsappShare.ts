export type WhatsAppShareMode = 'native' | 'fallback';

export async function fetchFacturaPdfFile(
  pdfUrl: string,
  filename: string,
): Promise<File> {
  const res = await fetch(pdfUrl);
  if (!res.ok) {
    throw new Error('No se pudo descargar el PDF de la factura');
  }
  const blob = await res.blob();
  const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : 'application/pdf';
  return new File([blob], filename, { type });
}

function triggerFileDownload(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function openWhatsAppChat(phone: string, text: string): void {
  window.open(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
}

/**
 * Intenta compartir el PDF adjunto vía Web Share API (móvil → WhatsApp con archivo).
 * En escritorio descarga el PDF y abre wa.me para adjuntarlo manualmente.
 */
export async function shareWhatsAppWithPdf(opts: {
  phone: string;
  text: string;
  file: File;
  waUrl?: string | null;
}): Promise<WhatsAppShareMode> {
  const shareData: ShareData = { text: opts.text, files: [opts.file] };

  if (typeof navigator.share === 'function' && navigator.canShare?.(shareData)) {
    try {
      await navigator.share(shareData);
      return 'native';
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Continúa al fallback si el share nativo falla por otra razón.
    }
  }

  triggerFileDownload(opts.file);
  if (opts.waUrl) {
    window.open(opts.waUrl, '_blank', 'noopener,noreferrer');
  } else {
    openWhatsAppChat(opts.phone, opts.text);
  }
  return 'fallback';
}
