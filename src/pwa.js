const SW_URL = `${import.meta.env.BASE_URL}sw.js`;

export async function registerPwa() {
  if (!import.meta.env.PROD) {
    return null;
  }

  if (!('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register(SW_URL, {
      scope: import.meta.env.BASE_URL,
    });
    console.log('NodeNote PWA registered', registration.scope);
    return registration;
  } catch (error) {
    console.warn('NodeNote PWA registration failed', error);
    return null;
  }
}
