export {};

export type UpdateStatus = { state: string; version?: string; percent?: number; message?: string; phase?: 'preparing' | 'downloading' | 'verifying'; fileName?: string; files?: string[]; artifactSize?: number; transferred?: number; total?: number; bytesPerSecond?: number; reusedBytes?: number; downloadMode?: 'differential' | 'full' | 'cached'; fallbackReason?: string };

export type HistoryOrder = ExecutionOrder & { hedgeId: string; runId: string; exchange: string; createdAt?: number; updatedAt?: number; dryRun?: boolean };
export type HistoryHedge = { id: string; source: string; target: string; symbols: string[]; totalMargin?: number; startedAt?: number; updatedAt?: number; state: string; active: boolean; dryRun?: boolean; error?: string; result?: TradeSnapshot['result']; orders: HistoryOrder[] };
export type TradingHistory = { kind: 'hedges' | 'orders'; rows: Array<HistoryHedge | HistoryOrder>; total: number; page: number; pages: number; unreadable: number };

export type HedgeOptions = { marginMode?: "isolated" | "cross"; source: string; target: string; symbols: string[]; totalMargin: number; leverageBySymbol: Record<string, number>; hedgePercent?: number; maxLosses?: number; dryRun?: boolean; liveConfirmation?: string; acceptImpact?: boolean };
export type ExecutionPolicy = { version: 2 | 3; firstLeg: 'source'; sourcePostOnly: boolean; targetPostOnly: boolean; immediateTarget?: boolean; targetMarketAttempts?: number; makerWaitMs: number; repriceMs: number };
export type HedgePlan = { source: string; target: string; execution?: ExecutionPolicy; totalMargin: number; available: number; createdAt: number; legs: Array<{ symbol: string; margin: number; leverage: number; notional: number; quantity: number; price: number; targetSide: string; sourcePrice: number; entryGapPercent: number; trend: { targetSide: string; changePercent: number; dayOpen: number; dayStartedAt: number }; impact: { buyDepth: number; sellDepth: number; estimatedLoss: number | null; impactPercent: number | null; insufficientDepth: boolean } }> };
export type LivePosition = { id: string; exchange: string; symbol: string; side: string; quantity: number; entryPrice: number | null; markPrice: number | null; unrealizedPnl: number | null; realizedPnl: number | null; margin: number | null; leverage: number | null; liquidationPrice: number | null; marginMode?: string };
export type LiveOrder = { id: string; exchange: string; symbol: string; side: string; quantity: number; price: number | null; type: string; status: string };
export type AccountSnapshot = { exchange: string; account: { available: number; total: number; balanceKind?: 'wallet' | 'equity'; rawUpdatedAt?: number } | null; positions: LivePosition[]; orders: LiveOrder[]; accountUpdatedAt?: number; positionsUpdatedAt?: number; ordersUpdatedAt?: number; updatedAt: number | null; latency?: number; status: "syncing" | "live" | "stale"; errors?: Record<string, string> };
export type PortfolioSnapshot = { exchanges: Record<string, AccountSnapshot>; receivedAt: number };
export type LBankRecorderStatus = { active: boolean; captureId: string | null; startedAt: number | null; eventCount: number; filePath: string | null; fileName: string | null; directory: string | null; error?: string | null };
export type ExecutionOrder = { leg: "source" | "target"; symbol: string; clientOrderId?: string; orderId?: string; quantity: number; executedQuantity: number; price?: number; postOnly?: boolean; averagePrice?: number | null; status: string; side: string; type?: string; reduceOnly?: boolean };
export type ProtectionOrder = { leg: 'source' | 'target'; symbol: string; clientOrderId?: string; orderId?: string; quantity: number; side: string; takeProfitPrice: number; stopLossPrice: number; triggerPriceType?: string; status: string; verifiedAt?: number };
export type TradeNotice = {code: string; level: 'info' | 'warning'; message: string; since?: number; exchanges?: string[]};
export type PnlTarget = {percent: number; requestedPercent?: number; margin: number; threshold: number; netThreshold?: number; estimatedFees?: number; quantity: number; entryPrice: number; leverage: number};
export type StopProgress = {phase: 'reconciling' | 'canceling' | 'closing' | 'confirming' | 'done'; leg?: 'source' | 'target'; symbol?: string; orderId?: string};
export type StopMode = 'pause' | 'app-only' | 'market';
export type CloseStatus = 'not_requested' | 'closing' | 'waiting_confirmation' | 'failed' | 'closed';
export type TradeSnapshot = { id?: string; source?: string; target?: string; execution?: ExecutionPolicy; totalMargin?: number; hedgePercent?: number; targetGoal?: number; remainingTarget?: number; realizedNet?: {source:number;target:number;total:number}; estimatedFees?: number; state: string; active: boolean; botStopped?: boolean; closeStatus?: CloseStatus; closeError?: string; manualManagement?: boolean; lossLimitReached?: boolean; maxLosses?: number; lossCount?: number; completedRounds?: number; nextRetryAt?: number; dryRun?: boolean; requiresAttention?: boolean; completedOrders?: number; totalOrders?: number; currentSymbol?: string; currentPnl?: { source: number | null; target: number | null }; targetProfit?: number; result?: { targetProfit: number; sourcePnl: number; netPnl: number; estimatedFees?: number; tradingVolume: number | null; provisional?: boolean }; error?: string; notice?: TradeNotice; runs?: Array<{ id: string; symbol: string; targetSide: string; sourceSide: string; leverage: number; quantity: number; hedgedQuantity: number; state: string; serverProtected?: boolean; requestedHedgePercent?: number; effectiveHedgePercent?: number; protections?: ProtectionOrder[]; pnlTarget?: PnlTarget; stopProgress?: StopProgress; execution?: ExecutionPolicy; targetOrder?: ExecutionOrder | null; targetOrders?: ExecutionOrder[]; sourceOrders: ExecutionOrder[]; closeOrders: ExecutionOrder[] }> };

export type AdminUser = {
  id: number;
  key: string;
  user_code: string | null;
  system_fingerprint: string | null;
  label: string | null;
  owner_note: string | null;
  created_at: string;
  activated_at: string | null;
  expires_at: string | null;
  last_renewed_at: string | null;
  last_used_at: string | null;
  revoked: boolean;
  valid_days: number | null;
  remaining_days: number | null;
  status: string;
};

declare global {
  interface Window {
    hedgeDesktop?: {
      window: (action: "minimize" | "maximize" | "close") => Promise<void>;
      loadSettings: () => Promise<Record<string, unknown> | null>;
      saveSettings: (value: Record<string, unknown>) => Promise<boolean>;
      loadCredentials: () => Promise<Record<string, Record<string, string>> | null>;
      saveCredentials: (value: Record<string, Record<string, string>>) => Promise<boolean>;
      listUndetectableProfiles: () => Promise<Array<{ id: string; name: string; status: string }>>;
      disconnectExchange: (id: string) => Promise<boolean>;
      getLBankRecorderStatus: () => Promise<LBankRecorderStatus>;
      startLBankRecorder: () => Promise<LBankRecorderStatus>;
      markLBankRecorder: (marker: string) => Promise<LBankRecorderStatus>;
      stopLBankRecorder: () => Promise<LBankRecorderStatus>;
      showLBankRecorder: () => Promise<boolean>;
      resetLossLimit: () => Promise<TradeSnapshot>;
      getExchangeMarkets: (exchangeId: string) => Promise<Array<{ symbol: string; lastPrice: number; markPrice: number; high24h: number; low24h: number; open24h: number; volume24h: number; turnover24h: number; fundingRate: number; makerFee?: number; takerFee?: number }>>;
      getExchangeDepth: (exchangeId: string, symbol: string) => Promise<{ symbol: string; bids: Array<{ price: number; quantity: number }>; asks: Array<{ price: number; quantity: number }>; receivedAt: number }>;
      getCommonMarkets: (sourceId: string, targetId: string) => Promise<Array<{ symbol: string; lastPrice: number; makerFee: number; takerFee: number; combinedTurnover: number; logoUrl?: string | null }>>;
      testExchange: (exchangeId: string) => Promise<{ ok: boolean; account?: { available: number; total: number; rawUpdatedAt?: number }; error?: string }>;
      testExchanges: (exchangeIds: string[]) => Promise<Record<string, { ok: boolean; account?: { available: number; total: number; rawUpdatedAt?: number }; latency?: number; error?: string }>>;
      startTrading: (options: HedgeOptions) => Promise<{ ok: boolean; error?: string; snapshot?: TradeSnapshot }>;
      previewHedge: (options: HedgeOptions) => Promise<{ ok: boolean; plan?: HedgePlan; error?: string; httpStatus?: number; retryAfterMs?: number }>;
      getTradingState: () => Promise<TradeSnapshot>;
      getTradingHistory: (options: { kind: 'hedges' | 'orders'; query?: string; page?: number }) => Promise<TradingHistory>;
      configureAccounts: (ids: string[]) => Promise<PortfolioSnapshot>;
      refreshAccounts: () => Promise<PortfolioSnapshot>;
      onAccountSnapshot: (callback: (value: PortfolioSnapshot) => void) => () => void;
      stopTrading: (mode: StopMode) => Promise<{ ok: boolean; botStopped?: boolean; error?: string; snapshot?: TradeSnapshot }>;
      verifyProfile: (options: { serverUrl: string; licenseKey: string }) => Promise<{ ok: boolean; error?: string; reason?: string; profile?: { userCode: string | null; expiresAt: string | null; isAdmin: boolean } }>;
      getProfileSession: () => Promise<{ authenticated: boolean; profile?: { userCode: string | null; expiresAt: string | null; isAdmin: boolean } }>;
      logoutProfile: () => Promise<boolean>;
      getAdminUsers: () => Promise<{ ok: boolean; users: AdminUser[]; error?: string }>;
      createAdminUser: (value: { name: string; ttlDays: number | null; note?: string }) => Promise<{ ok: boolean; user?: AdminUser; error?: string }>;
      updateAdminUser: (keyId: number, value: { name?: string; note?: string; revoked?: boolean; reset_device?: boolean; extend_days?: number }) => Promise<{ ok: boolean; user?: AdminUser; error?: string }>;
      configureUpdates: (options: { channel: "beta" | "stable"; serverUrl: string; autoUpdate: boolean; launchOnStartup: boolean }) => Promise<UpdateStatus & { ok: boolean }>;
      getUpdateStatus: () => Promise<UpdateStatus>;
      downloadUpdate: () => Promise<{ ok: boolean }>;
      installUpdate: () => Promise<boolean>;
      sendLogs: () => Promise<{ ok: boolean; bytes?: number; error?: string }>;
      openTelegram: () => Promise<boolean>;
      onUpdateStatus: (callback: (value: UpdateStatus) => void) => () => void;
      onTradingState: (callback: (value: TradeSnapshot) => void) => () => void;
    };
  }
}
