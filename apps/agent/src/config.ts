// Конфигурация агента. Секреты (enrollment token, ключи) — через env/файлы,
// не в образе. Агент устанавливает ИСХОДЯЩЕЕ соединение с control plane.

const env = (n: string, d = '') => process.env[n] ?? d;
const int = (n: string, d: number) => {
  const v = Number(process.env[n]);
  return Number.isFinite(v) ? v : d;
};

export const config = {
  controlPlaneUrl: env('CONTROL_PLANE_URL', 'http://localhost:3000'),
  // Одноразовый enrollment token (после регистрации становится недействительным).
  enrollmentToken: env('AGENT_ENROLLMENT_TOKEN', ''),
  dataDir: env('AGENT_DATA_DIR', '/var/lib/novpn-agent'),
  healthPort: int('AGENT_PORT', 9090),
  heartbeatSec: int('AGENT_HEARTBEAT_SEC', 20),
  jobPollSec: int('AGENT_JOB_POLL_SEC', 5),
  logLevel: env('LOG_LEVEL', 'info'),
  version: '0.1.0',

  // Пути/имена контейнеров Amnezia (совместимо со стандартной установкой).
  xrayContainer: env('XRAY_CONTAINER', 'amnezia-xray'),
  xrayConfigPath: env('XRAY_CONFIG_PATH', '/opt/amnezia/xray/server.json'),
  xrayEndpointHost: env('XRAY_ENDPOINT_HOST', ''),
  xrayEndpointPort: env('XRAY_ENDPOINT_PORT', '443'),
  xrayFingerprint: env('XRAY_FINGERPRINT', 'chrome'),

  awgContainer: env('AMNEZIAWG_CONTAINER', 'amnezia-awg2'),
  awgInterface: env('AMNEZIAWG_INTERFACE', 'awg0'),
  awgConfigPath: env('AMNEZIAWG_CONFIG_DIR', '/opt/amnezia/awg/awg0.conf'),
  awgEndpointHost: env('AMNEZIAWG_ENDPOINT_HOST', ''),
  awgEndpointPort: env('AMNEZIAWG_ENDPOINT_PORT', '51820'),
  awgBaseNet: env('AMNEZIAWG_BASE_NET', '10.8.0'),
};

export type AgentConfig = typeof config;
