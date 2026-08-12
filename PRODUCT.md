# Product

## Register

product

## Users

Equipos de búsqueda y rescate (voluntarios y profesionales) operando en zonas de escombros tras el sismo de Cali, Colombia. Usan la app bajo alto estrés, con luz solar directa, posible polvo o suciedad sobre la pantalla, y con las manos ocupadas o enguantadas. La conectividad es intermitente o nula (red local air-gapped, offline-first). El objetivo inmediato es localizar personas atrapadas en estructuras colapsadas lo más rápido posible.

## Product Purpose

ESPetral Rescue es un multiplicador de fuerza para equipos de campo: fusiona detección de movimiento Wi-Fi CSI (nodos ESP32), detección acústica de golpes (móvil) y registro GPS en un indicador único de probabilidad por zona. No reemplaza a un equipo de rescate profesional. Éxito = que una alerta de zona o un patrón de golpe detectado sea visible e inequívoco en menos de un segundo de mirada, incluso bajo sol directo y estrés.

## Brand Personality

Táctica, de alto contraste, sin decoración. Prioriza legibilidad bajo estrés y sol directo por encima de la estética pulida — más cerca de software de emergencia/instrumentación de campo que de una app de consumo. Directa y seria, sin tono lúdico ni voz de marca.

## Anti-references

Apps de consumo pulidas (paletas SaaS-cream, gradientes, tarjetas decorativas, copy juguetón). Cualquier elemento decorativo que compita visualmente con una alerta crítica ("hay posible movimiento/víctima aquí") es un error de diseño, no un detalle menor.

## Design Principles

- Legibilidad bajo sol directo y pantalla sucia por encima de la estética pulida.
- Cero ambigüedad en alertas críticas: un golpe detectado o una zona de alta probabilidad debe ser imposible de pasar por alto.
- Un vistazo, una decisión: el estado del sistema se entiende sin leer.
- Targets táctiles y tipografía dimensionados para uso con estrés o guantes (piso ya establecido: 48px táctil, 14px cuerpo, 12px metadata).
- Degradación consciente: todo indicador de fallo (offline, sin GPS, sin audio) debe ser tan visible como uno de éxito.

## Accessibility & Inclusion

Contraste alto por defecto (WCAG AA como piso; AAA en elementos de alerta). Touch targets mínimo 48×48px (regla existente del proyecto). Sin dependencia exclusiva del color para comunicar estado — mantener el patrón ya usado en alertas (color + texto + animación). UI 100% en español. `prefers-reduced-motion` debe respetarse en toda animación, incluida la pulsación de alerta de golpe.
