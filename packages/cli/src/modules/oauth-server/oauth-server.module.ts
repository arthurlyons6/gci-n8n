import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule } from '@n8n/decorators';

/**
 * Shared OAuth 2.1 authorization server.
 *
 * Serves a single issuer (the instance origin) with shared
 * `/authorize`/`/token`/`/register`/`/revoke` endpoints and discovery
 * documents for the protected resources registered in the
 * `ProtectedResourceRegistry` (e.g. the instance MCP server).
 */
@BackendModule({ name: 'oauth-server', instanceTypes: ['main'] })
export class OAuthServerModule implements ModuleInterface {
	async init() {
		await import('./oauth.controller');
		await import('./oauth-consent.controller');
		await import('./oauth-clients.controller');
	}

	async entities() {
		const { OAuthClient } = await import('./database/entities/oauth-client.entity');
		const { AuthorizationCode } = await import(
			'./database/entities/oauth-authorization-code.entity'
		);
		const { AccessToken } = await import('./database/entities/oauth-access-token.entity');
		const { RefreshToken } = await import('./database/entities/oauth-refresh-token.entity');
		const { UserConsent } = await import('./database/entities/oauth-user-consent.entity');

		return [OAuthClient, AuthorizationCode, AccessToken, RefreshToken, UserConsent] as never;
	}
}
