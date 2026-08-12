/**
 * Tests unitarios del anunciador mDNS.
 *
 * mDNS requiere una red multicast real para funcionar de punta a punta, algo
 * que no se debe depender en CI. Estos tests mockean `bonjour-service` para
 * validar que `startMdnsAnnouncer`:
 * - no lanza excepciones
 * - publica el servicio con el nombre de tipo, hostname y puerto esperados
 * - al detenerse, despublica el servicio correctamente
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishMock = vi.fn();
const unpublishAllMock = vi.fn((callback?: () => void) => callback?.());
const destroyMock = vi.fn();

vi.mock('bonjour-service', () => {
  return {
    Bonjour: vi.fn().mockImplementation(function BonjourMock(this: unknown) {
      Object.assign(this as object, {
        publish: publishMock,
        unpublishAll: unpublishAllMock,
        destroy: destroyMock,
      });
    }),
  };
});

import {
  startMdnsAnnouncer,
  MDNS_HOSTNAME,
  MDNS_SERVICE_TYPE,
  MDNS_SERVICE_NAME,
} from './mdns-announcer.js';

describe('startMdnsAnnouncer', () => {
  beforeEach(() => {
    publishMock.mockClear();
    unpublishAllMock.mockClear();
    destroyMock.mockClear();
    publishMock.mockReturnValue({ name: MDNS_SERVICE_NAME });
  });

  it('no lanza excepción al anunciar el servicio', () => {
    expect(() => startMdnsAnnouncer(1883)).not.toThrow();
  });

  it('publica el servicio _cali-mqtt._tcp con hostname y puerto esperados', () => {
    startMdnsAnnouncer(1883);

    expect(publishMock).toHaveBeenCalledTimes(1);
    expect(publishMock).toHaveBeenCalledWith({
      name: MDNS_SERVICE_NAME,
      type: MDNS_SERVICE_TYPE,
      protocol: 'tcp',
      host: MDNS_HOSTNAME,
      port: 1883,
    });
  });

  it('usa el puerto MQTT recibido, no un valor fijo', () => {
    startMdnsAnnouncer(18830);

    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 18830 })
    );
  });

  it('al detenerse, despublica todos los servicios y destruye la instancia', async () => {
    const announcer = startMdnsAnnouncer(1883);

    await announcer.stop();

    expect(unpublishAllMock).toHaveBeenCalledTimes(1);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });
});
