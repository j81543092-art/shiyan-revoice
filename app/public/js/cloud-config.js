/**
 * 云服务公开配置（publicConfig）
 *
 * 只有这三个值可以出现在前端代码里 ——
 * 它们是公开的：publishableKey 只标识「是哪个应用」，本身不带任何权限，
 * 服务端会强制校验精确 Origin。底层环境 id 与 provider 密钥永远不下发到前端。
 *
 * 开通云服务后，把 tool 返回的 publicConfig 填到这里：
 *   window.__REVOICE_CLOUD__ = {
 *     resourceId: '...',
 *     endpoint: 'https://xxx.workbuddy.link',
 *     publishableKey: '...',
 *   };
 *
 * 未填写时登录页会明确提示「云服务尚未开通」，而不是给一个假登录。
 */
window.__REVOICE_CLOUD__ = null;
