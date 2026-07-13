import { ConfigService, EvolutionHub } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException } from '@exceptions';
import axios, { AxiosInstance } from 'axios';

// ---- Tipos do contrato do hub (espelham evolutionHubService.ts do frontend) ----

export interface HubPlan {
  id: string;
  slug: string;
  name: string;
  allow_own_meta_app: boolean;
  allow_shared_meta_app: boolean;
  max_channels_total: number | null;
  max_webhooks: number | null;
  max_byo_credentials: number | null;
}

export interface MetaAppOptionCred {
  id: string;
  app_id: string;
  name: string;
}

export interface MetaAppOptions {
  allowed_modes: ('shared' | 'byo')[];
  shared_configured: boolean;
  shared_allowed_by_plan: boolean;
  byo_allowed_by_plan: boolean;
  byo_credentials: MetaAppOptionCred[];
}

// meta_connection embutido no canal completo (GET /api/v1/channels/:id)
// — channel.go:81 + 186-188 (phone_number_id, waba_id em meta_connection)
export interface HubMetaConnection {
  phone_number_id?: string | null;
  waba_id?: string | null;
  business_id?: string | null;
  connection_mode?: 'shared' | 'byo';
}

export interface HubChannel {
  id: string;
  name: string;
  type: 'whatsapp' | 'facebook' | 'instagram';
  status: string;
  channel_credentials_id?: string | null;
  created_at?: string;
  // Presentes no GET /api/v1/channels/:id (canal COMPLETO via ToResponse()):
  // token = channel.go:135; meta_connection = channel.go:81/186-188.
  // O GET de lista (/channels) pode NÃO trazer estes campos — só o GET por id traz.
  token?: string | null;
  meta_connection?: HubMetaConnection | null;
}

// Webhook do hub (WebhookResponse — webhook.go:116). Só os campos que usamos.
export interface HubWebhookInfo {
  id: string;
  name?: string;
  url: string;
  status?: string;
  all_channels?: boolean;
}

// ---- Criar-novo (POST /api/v1/channels) ----
export interface HubProvisionRequest {
  name: string;
  type: 'whatsapp' | 'facebook' | 'instagram';
  channel_credentials_id?: string | null; // set => byo; omitido => shared
  webhook_url?: string; // se setado, o hub registra o webhook (single-shot)
}

export interface HubProvisionResponse {
  channel_token: string; // channel.token devolvido pelo POST /api/v1/channels
  public_link: string; // CONSTRUÍDO: `${FRONTEND_URL}/connect/${channel_token}`
  hub_channel_id: string;
}

// POST /api/v1/channels/:id/meta-connect — contrato exato do MetaConnectRequest (Go)
export interface MetaConnectRequest {
  phone_number_id: string;
  waba_id: string;
  business_id: string;
  auth_code: string;
  connection_mode: 'shared' | 'byo';
}

export interface MetaConnectResponse {
  success: boolean;
  message: string;
  data: {
    channel_id: string;
    connection_mode: string;
    waba_name: string;
    business_name: string;
    phone_numbers: number;
  };
}

/**
 * EvoHubClient — cliente HTTP do control-plane do hub. Usa a API-key global
 * (EVOLUTION_HUB_API_KEY) como Bearer, base path `/api/v1`. A API-key NUNCA é logada
 * nem exposta em respostas; o channel_token resolvido no link-existing nunca trafega
 * para o front.
 */
export class EvoHubClient {
  private readonly logger = new Logger('EvoHubClient');
  private readonly http: AxiosInstance;

  constructor(private readonly configService: ConfigService) {
    const cfg = this.configService.get<EvolutionHub>('EVOLUTION_HUB');
    this.http = axios.create({
      baseURL: `${cfg.URL}/api/v1`,
      headers: {
        Authorization: `Bearer ${cfg.API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
  }

  async getPlan(): Promise<HubPlan> {
    // Endpoint self-service do hub: GET /api/v1/me/plan (GetMyPlan). NÃO usar /plan
    // (esse é o admin GET por id e exige UUID param).
    const { data } = await this.http.get('/me/plan');
    return data;
  }

  async getMetaAppOptions(): Promise<MetaAppOptions> {
    // GET /api/v1/me/meta-app-options (credentials/handler.go:37).
    const { data } = await this.http.get('/me/meta-app-options');
    return data;
  }

  async listChannels(type?: 'whatsapp' | 'facebook' | 'instagram'): Promise<HubChannel[]> {
    const { data } = await this.http.get('/channels', { params: type ? { type } : {} });
    // O hub devolve { channels: [...], count } (channel_handler.go GetChannels).
    // Tolera também array nu ou { data: [...] } por robustez.
    return this.normalizeChannelList(data);
  }

  // SSRF guard: channel/webhook ids do hub são UUID (o hub faz uuid.Parse). Validamos
  // ANTES de interpolar o id no path da request ao hub — recusa path/URL injection
  // vinda de req.params/req.body em vez de repassá-la para o control-plane.
  private assertHubId(id: string): void {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
      throw new BadRequestException(`invalid hub id: ${id}`);
    }
  }

  // Normaliza a resposta de lista do hub para HubChannel[] (channels|data|array nu).
  private normalizeChannelList(data: any): HubChannel[] {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.channels)) return data.channels;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }

  /**
   * Canal COMPLETO por id (contrato §2/§4A): GET /api/v1/channels/:id devolve
   * `token` + `meta_connection.phone_number_id` (channel_handler.go:185-202 →
   * ToResponse()). Base do link-existing — o evolution-api extrai esses campos
   * server-side; o front NUNCA vê o token.
   */
  async getChannel(id: string): Promise<HubChannel> {
    this.assertHubId(id);
    const { data } = await this.http.get(`/channels/${id}`);
    return data;
  }

  /**
   * Canais disponíveis para vincular = lista do hub (GET /api/v1/channels). A
   * filtragem dos já-vinculados é feita na rota /evohub/available-channels.
   */
  async getAvailableChannels(type?: 'whatsapp' | 'facebook' | 'instagram'): Promise<HubChannel[]> {
    return this.listChannels(type);
  }

  // ---- Webhooks (inbound do hub -> evolution-api) ----

  /** Webhooks já ASSOCIADOS ao canal: GET /api/v1/channels/:id/webhooks → { webhooks, count }. */
  async listChannelWebhooks(channelId: string): Promise<HubWebhookInfo[]> {
    this.assertHubId(channelId);
    const { data } = await this.http.get(`/channels/${channelId}/webhooks`);
    return this.normalizeWebhookList(data);
  }

  /** Todos os webhooks do usuário da API-key: GET /api/v1/webhooks. */
  async listWebhooks(): Promise<HubWebhookInfo[]> {
    const { data } = await this.http.get('/webhooks');
    return this.normalizeWebhookList(data);
  }

  private normalizeWebhookList(data: any): HubWebhookInfo[] {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.webhooks)) return data.webhooks;
    if (Array.isArray(data?.data)) return data.data;
    return [];
  }

  /** POST /api/v1/webhooks/:id/associate — associa um webhook existente ao canal. */
  async associateWebhook(webhookId: string, channelId: string): Promise<void> {
    this.assertHubId(webhookId);
    this.assertHubId(channelId);
    await this.http.post(`/webhooks/${webhookId}/associate`, { channel_id: channelId });
  }

  /**
   * PUT /api/v1/webhooks/:id/status — reativa/desativa um webhook. O hub só aceita
   * `active`|`inactive`; reativar com `active` é o caminho oficial para tirar um
   * webhook do estado auto-`disabled` (webhook.go:104).
   */
  async setWebhookStatus(webhookId: string, status: 'active' | 'inactive'): Promise<void> {
    this.assertHubId(webhookId);
    await this.http.put(`/webhooks/${webhookId}/status`, { status });
  }

  /** PUT /api/v1/webhooks/:id/secret — grava o secret usado para assinar o inbound. */
  async setWebhookSecret(webhookId: string, secret: string): Promise<void> {
    this.assertHubId(webhookId);
    await this.http.put(`/webhooks/${webhookId}/secret`, { secret });
  }

  /**
   * Reescreve o WEBHOOK_SECRET configurado num webhook que estamos REUSANDO. O hub só
   * assina o inbound quando o webhook tem secret gravado (webhook_dispatcher.go:983) e
   * o WebhookResponse NÃO expõe o secret nem um `has_secret` (webhook.go:116) — não há
   * como detectar drift, então reescrevemos sempre. Sem isso, um webhook criado em soft
   * mode (secret vazio) ou com secret antigo é reusado como se estivesse pronto, o hub
   * entrega sem assinatura/com assinatura errada, o verifyHmac responde 401 e o canal
   * fica surdo — o mesmo sintoma que este fluxo existe para matar. Pior: o webhook é
   * COMPARTILHADO entre os canais, então o 401 repetido leva o hub a auto-desabilitá-lo
   * e derruba o inbound de todos eles.
   *
   * Secret vazio → soft mode: o inbound aceita sem assinatura, nada a garantir.
   */
  private async syncWebhookSecret(webhookId: string): Promise<void> {
    const secret = this.configService.get<EvolutionHub>('EVOLUTION_HUB').WEBHOOK_SECRET;
    if (!secret) return;
    await this.setWebhookSecret(webhookId, secret);
  }

  /**
   * Garante (idempotente) que o canal tem um webhook ATIVO apontando para
   * `webhookUrl` — o caminho single-shot do provision não existe no link-existing,
   * e sem webhook (ou com webhook não-`active`) o canal envia mas nunca RECEBE.
   *
   * O dispatcher do hub só entrega quando `status == 'active'` (webhook_dispatcher.go:294);
   * um webhook em `disabled` (auto-desativado após falhas de entrega) ou `inactive`
   * casa a URL mas NÃO entrega, então reativamos em vez de tratar como pronto —
   * senão o re-link responde 201 e o canal segue surdo. Em todo REUSO o secret é
   * reescrito antes da reativação (syncWebhookSecret) — um webhook com secret
   * defasado tomaria 401 no inbound e voltaria a ser auto-desabilitado. Ordem:
   * 1) já associado ao canal com a mesma URL → garante secret e reativa se preciso;
   * 2) webhook do usuário com a mesma URL → garante secret, reativa e associa
   *    (all_channels já cobre o canal, então só garante que está ativo);
   * 3) cria novo com `channels: [channelId]` (single-shot) e `events: []`
   *    (vazio = TODOS os eventos — webhook_service.go:98). Secret = recipe
   *    register-with-own-secret, igual ao provision.
   */
  async ensureChannelWebhook(channelId: string, webhookUrl: string): Promise<void> {
    this.assertHubId(channelId);

    const associated = await this.listChannelWebhooks(channelId);
    const match = associated.find((w) => w.url === webhookUrl);
    if (match) {
      await this.syncWebhookSecret(match.id);
      if (match.status !== 'active') await this.setWebhookStatus(match.id, 'active');
      return;
    }

    const all = await this.listWebhooks();
    const existing = all.find((w) => w.url === webhookUrl);
    if (existing) {
      await this.syncWebhookSecret(existing.id);
      if (existing.status !== 'active') await this.setWebhookStatus(existing.id, 'active');
      if (!existing.all_channels) await this.associateWebhook(existing.id, channelId);
      return;
    }

    const cfg = this.configService.get<EvolutionHub>('EVOLUTION_HUB');
    const body: Record<string, any> = {
      name: 'evolution-api inbound',
      url: webhookUrl,
      events: [],
      channels: [channelId],
    };
    if (cfg.WEBHOOK_SECRET) body.secret = cfg.WEBHOOK_SECRET;
    await this.http.post('/webhooks', body);
  }

  // ---- Fase 2 ----

  /**
   * Cria um canal novo no hub (POST /api/v1/channels) e CONSTRÓI o public_link a
   * partir do channel.token devolvido (contrato §3 — NÃO é campo do hub):
   * `${FRONTEND_URL}/connect/${channel_token}`.
   *
   * Request real do hub (CreateChannelRequest): { name, type, webhook_url?,
   * webhook_secret? }. Quando webhook_url é enviado, o hub registra o webhook
   * E retorna a resposta ENVELOPADA em { channel, webhook_id }; sem webhook a
   * resposta é o ChannelResponse plano. Normalizamos os dois.
   *
   * Webhook = recipe register-with-own-secret (contrato §7): registramos com o
   * nosso EVOLUTION_HUB_WEBHOOK_SECRET, então o hub assina os webhooks com ele e
   * a validação HMAC no inbound bate.
   */
  async provisionChannel(req: HubProvisionRequest): Promise<HubProvisionResponse> {
    const cfg = this.configService.get<EvolutionHub>('EVOLUTION_HUB');
    const body: Record<string, any> = {
      name: req.name,
      type: req.type,
    };
    if (req.channel_credentials_id) body.channel_credentials_id = req.channel_credentials_id;
    // Registra o webhook do evolution-api junto da criação (single-shot) para
    // receber mensagens inbound. webhook_secret = nosso secret (register-with-own-secret).
    if (req.webhook_url) {
      body.webhook_url = req.webhook_url;
      if (cfg.WEBHOOK_SECRET) body.webhook_secret = cfg.WEBHOOK_SECRET;
    }

    const { data } = await this.http.post('/channels', body);
    // Normaliza: { channel: {...}, webhook_id } (com webhook) OU ChannelResponse plano.
    const channel = data?.channel ?? data;
    const channelToken: string = channel.token;
    const hubChannelId: string = channel.id;

    return {
      channel_token: channelToken,
      public_link: `${cfg.FRONTEND_URL}/connect/${channelToken}`,
      hub_channel_id: hubChannelId,
    };
  }

  /**
   * (FASE 2) Conecta o canal no hub. connection_mode='shared' usa o Meta App da
   * Evolution; 'byo' exige channel_credentials no hub.
   */
  async connectToMeta(channelId: string, req: MetaConnectRequest): Promise<MetaConnectResponse> {
    this.assertHubId(channelId);
    const { data } = await this.http.post(`/channels/${channelId}/meta-connect`, req);
    return data;
  }
}
