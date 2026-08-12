/**
 * ESPetral Rescue — Anuncio mDNS del backend
 *
 * POR QUE EXISTE ESTE MODULO:
 * Los nodos ESP32 hoy se conectan al backend usando una IP fija grabada en su
 * NVS (memoria no volatil) al momento de flashear el firmware. En un sitio de
 * rescate real, la laptop que corre el backend puede cambiar de red Wi-Fi o
 * recibir una IP distinta por DHCP en cada despliegue — eso obligaria a
 * reflashear cada ESP32 por USB antes de cada operativo, algo impracticable
 * en campo.
 *
 * La solucion es anunciar el backend via mDNS (multicast DNS, RFC 6762) bajo
 * un nombre estable: `cali-backend.local`. Los nodos ESP32 resuelven ese
 * nombre en la red local sin depender de la IP actual ni de un servidor DNS
 * externo. mDNS es puramente multicast dentro del segmento de red local, por
 * lo que no requiere conectividad a internet — compatible con el requisito
 * offline-first / air-gapped del proyecto (busqueda y rescate puede operar
 * sin infraestructura de red externa).
 */

import { Bonjour, type Service } from 'bonjour-service';

/** Hostname mDNS estable bajo el cual se publica el backend. */
export const MDNS_HOSTNAME = 'cali-backend.local';

/** Tipo de servicio mDNS anunciado (sin protocolo ni guion bajo inicial: bonjour-service los agrega). */
export const MDNS_SERVICE_TYPE = 'cali-mqtt';

/** Nombre legible de la instancia del servicio anunciado. */
export const MDNS_SERVICE_NAME = 'ESPetral Rescue Backend';

export interface MdnsAnnouncerInstance {
  /** Instancia de Bonjour usada para publicar/despublicar el servicio. */
  bonjour: Bonjour;
  /** Servicio mDNS publicado (_cali-mqtt._tcp). */
  service: Service;
  /** Detiene el anuncio mDNS y libera los recursos de red asociados. */
  stop(): Promise<void>;
}

/**
 * Publica el broker MQTT del backend como servicio mDNS `_cali-mqtt._tcp`
 * bajo el hostname estable `cali-backend.local`.
 *
 * Debe llamarse DESPUES de que el broker MQTT (Aedes) ya este escuchando en
 * `mqttPort`, para no anunciar un servicio que todavia no acepta conexiones.
 */
export function startMdnsAnnouncer(mqttPort: number): MdnsAnnouncerInstance {
  const bonjour = new Bonjour();

  const service = bonjour.publish({
    name: MDNS_SERVICE_NAME,
    type: MDNS_SERVICE_TYPE,
    protocol: 'tcp',
    host: MDNS_HOSTNAME,
    port: mqttPort,
  });

  console.log(
    `[mdns] Servicio _${MDNS_SERVICE_TYPE}._tcp anunciado como ${MDNS_HOSTNAME}:${mqttPort}`
  );

  async function stop(): Promise<void> {
    return new Promise((resolve) => {
      bonjour.unpublishAll(() => {
        bonjour.destroy();
        resolve();
      });
    });
  }

  return { bonjour, service, stop };
}
