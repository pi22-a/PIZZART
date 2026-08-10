import { defineConfig } from 'vitest/config';

const GAME_SERVER = process.env.PIZZA_SERVER ?? 'ws://localhost:8080';

export default defineConfig({
  server: {
    port: 5173,
    // /ws 를 게임 서버로 넘긴다. 브라우저가 보기엔 포트가 하나뿐이라
    // 터널을 뚫을 때도 하나만 뚫으면 되고, https면 wss가 자동으로 따라온다.
    proxy: {
      '/ws': { target: GAME_SERVER, ws: true },
    },
    /**
     * vite는 자기가 아는 호스트 이름으로 온 요청만 받는다(DNS 리바인딩 방어).
     * 터널 주소는 켤 때마다 바뀌므로 도메인 단위로 열어둔다.
     */
    allowedHosts: [
      '.trycloudflare.com',
      '.ngrok-free.app',
      '.ngrok.io',
      '.loca.lt',
      ...(process.env.PIZZA_HOST ? [process.env.PIZZA_HOST] : []),
    ],
  },
  test: { globals: true, environment: 'node' },
});
