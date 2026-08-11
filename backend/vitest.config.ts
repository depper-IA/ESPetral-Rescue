import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // El paquete se instala como better-sqlite3 via alias pnpm,
      // pero el código importa desde better-sqlite3-multiple-ciphers
      'better-sqlite3-multiple-ciphers': 'better-sqlite3',
    },
  },
  test: {
    // Excluir directorio de compilación para evitar conflictos de puertos
    exclude: ['node_modules', 'dist'],
  },
});
