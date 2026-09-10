/** User-agent heuristics for the invite page and push guidance. */

export function isInAppBrowser(ua: string = navigator.userAgent): boolean {
  return /WhatsApp|Instagram|FBAN|FBAV|FB_IAB|Line\/|Twitter|TikTok|Snapchat/i.test(ua);
}

export function isIos(ua: string = navigator.userAgent): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isAndroid(ua: string = navigator.userAgent): boolean {
  return /Android/i.test(ua);
}

/** Installed to the home screen (standalone display mode). */
export function isStandalone(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch {
    return false;
  }
}

export function supportsNfc(): boolean {
  return typeof window !== 'undefined' && 'NDEFReader' in window;
}

export function supportsPush(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
