import { GlobalConfig } from '@n8n/config';
import { AuthenticatedRequest } from '@n8n/db';
import { Get, Options, Post, RestController } from '@n8n/decorators';
import { NextFunction, Response } from 'express';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';

@RestController('/telemetry')
export class TelemetryController {
	proxy;

	constructor(private readonly globalConfig: GlobalConfig) {
		this.proxy = createProxyMiddleware({
			target: this.globalConfig.diagnostics.frontendConfig.split(';')[1],
			changeOrigin: true,
			pathRewrite: {
				'^/proxy/': '/', // /proxy/v1/track -> /v1/track
			},
			on: {
				proxyReq: (proxyReq, req) => {
					proxyReq.removeHeader('cookie');
					fixRequestBody(proxyReq, req);
					return;
				},
				proxyRes: (proxyRes) => {
					// MCP app UIs call this cross-origin from a sandboxed iframe (often an
					// opaque `null` origin). The upstream data plane sets its own CORS
					// headers; strip them all and emit exactly one permissive value so the
					// browser never sees a duplicate/conflicting Access-Control-Allow-Origin.
					for (const header of [
						'access-control-allow-origin',
						'access-control-allow-credentials',
						'access-control-allow-methods',
						'access-control-allow-headers',
						'access-control-expose-headers',
					]) {
						delete proxyRes.headers[header];
					}
					proxyRes.headers['access-control-allow-origin'] = '*';
				},
				error: (_error, _req, res) => {
					// If the upstream can't be reached, still return CORS so the browser
					// surfaces the real failure instead of a misleading CORS error.
					if ('writeHead' in res && !res.headersSent) {
						res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
						res.end('Bad Gateway');
					}
				},
			},
		});
	}

	/**
	 * CORS for the telemetry endpoints. They are unauthenticated and
	 * cookie-stripped passthroughs to a fixed target, so allowing any origin
	 * carries no credentialed-data risk and lets MCP app UIs running in
	 * third-party host iframes reach them. `Authorization` is allowed because
	 * the RudderStack SDK sends the write key as a Basic auth header.
	 */
	private applyCors(req: AuthenticatedRequest, res: Response) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		// Reflect whatever headers the browser asks for in the preflight. The
		// RudderStack SDK sends Content-Type, Authorization and anonymousId, and the
		// exact set can vary by SDK version, so reflecting avoids the preflight
		// rejecting an unexpected request header.
		const requestedHeaders = req.headers['access-control-request-headers'];
		res.setHeader(
			'Access-Control-Allow-Headers',
			typeof requestedHeaders === 'string' && requestedHeaders.length > 0
				? requestedHeaders
				: 'Content-Type, Authorization, anonymousId',
		);
		res.setHeader('Access-Control-Max-Age', '600');
		// Security invariant: `Access-Control-Allow-Origin: *` must NEVER be paired
		// with credentials, or any website could read authenticated responses using
		// the visitor's cookies. These endpoints are unauthenticated and
		// cookie-stripped, so `*` is safe — but only as long as credentials stay
		// off. Explicitly ensure no upstream/middleware layer slipped the header in.
		res.removeHeader('Access-Control-Allow-Credentials');
	}

	@Options('/proxy/:version/:action', { skipAuth: true })
	proxyPreflight(req: AuthenticatedRequest, res: Response) {
		this.applyCors(req, res);
		res.status(204).end();
	}

	@Post('/proxy/:version/track', { skipAuth: true, ipRateLimit: { limit: 100, windowMs: 60_000 } })
	async track(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		this.applyCors(req, res);
		await this.proxy(req, res, next);
	}

	@Post('/proxy/:version/identify', {
		skipAuth: true,
		ipRateLimit: { limit: 100, windowMs: 60_000 },
	})
	async identify(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		this.applyCors(req, res);
		await this.proxy(req, res, next);
	}

	@Post('/proxy/:version/page', { skipAuth: true, ipRateLimit: { limit: 50, windowMs: 60_000 } })
	async page(req: AuthenticatedRequest, res: Response, next: NextFunction) {
		this.applyCors(req, res);
		await this.proxy(req, res, next);
	}

	@Options('/rudderstack/sourceConfig', { skipAuth: true })
	sourceConfigPreflight(req: AuthenticatedRequest, res: Response) {
		this.applyCors(req, res);
		res.status(204).end();
	}

	@Get('/rudderstack/sourceConfig', {
		skipAuth: true,
		ipRateLimit: { limit: 50, windowMs: 60_000 },
		usesTemplates: true,
	})
	async sourceConfig(req: AuthenticatedRequest, res: Response) {
		this.applyCors(req, res);

		const response = await fetch('https://api-rs.n8n.io/sourceConfig', {
			headers: {
				authorization:
					'Basic ' + btoa(`${this.globalConfig.diagnostics.frontendConfig.split(';')[0]}:`),
			},
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch source config: ${response.statusText}`);
		}

		const config: unknown = await response.json();

		// write directly to response to avoid wrapping the config in `data` key which is not expected by RudderStack sdk
		res.json(config);
	}
}
