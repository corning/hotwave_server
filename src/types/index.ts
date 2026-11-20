// ===== DB rows =====
export interface UserRow {
  id: number;
  phone: string;
  password_hash: string | null;
  nickname: string;
  avatar: string;
  created_at: string;
  updated_at: string;
}

// ===== JWT =====
export interface JwtPayload {
  userId: number;
  phone: string;
}

// ===== Request bodies =====
export interface LoginRequest {
  phone: string;
  password?: string;
}

// ===== Response shapes =====
export interface LoginResponse {
  token: string;
  user: {
    id: number;
    phone: string;
    nickname: string;
    avatar: string;
  };
}

export interface UserInfoResponse {
  id: number;
  phone: string;
  nickname: string;
  avatar: string;
}

export interface MessageResponse {
  message: string;
}

// ===== Chat =====
export interface ChatMessageRow {
  id: number;
  user_id: number;
  agent_id: string;
  role: 'user' | 'assistant';
  content: string;
  error_message?: string | null;
  created_at: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  type: 'mock' | 'http' | 'ws';
  endpoint?: string;
  connected: boolean;
}

export interface ChatSendRequest {
  agentId: string;
  content: string;
}

// ===== Auth context (extracted from request) =====
export interface AuthContext {
  userId: number;
  phone: string;
  // 设备上下文（埋点 / 黑白名单）：由 APP 端 HttpUtil 注入请求头解析而来。
  deviceId?: string;
  platform?: string; // android | ios | ohos | web
  deviceModel?: string;
  osVersion?: string;
  appVersion?: string;
  ip?: string;
}

/** 客户端设备信息（从请求头 + IP 解析，独立于登录态）。 */
export interface DeviceInfo {
  deviceId: string;
  platform: string;
  deviceModel: string;
  osVersion: string;
  appVersion: string;
  ip: string;
}

// ===== hotwave 绑定关系 =====
// hotwave 实例与用户绑定：binding_id + secret 鉴权，交易归属绑定用户。
export interface CreateBindingBody {
  label?: string;
}

// 创建绑定返回（secret 明文仅此一次）
export interface CreateBindingResponse {
  id: number;
  bindingId: string;
  secret: string;
  label: string;
  createdAt: string;
}

// 绑定列表项（不含 secret）
export interface BindingItem {
  id: number;
  userId: number;
  bindingId: string;
  label: string;
  status: 'active' | 'revoked';
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}
