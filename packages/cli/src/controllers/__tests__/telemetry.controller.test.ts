import type { GlobalConfig } from '@n8n/config';
import type { AuthenticatedRequest } from '@n8n/db';
import type { NextFunction, Response } from 'express';
import { mock } from 'jest-mock-extended';

import { TelemetryController } from '@/controllers/telemetry.controller';

describe('TelemetryController', () => {
	const globalConfig = mock<GlobalConfig>({
		diagnostics: { frontendConfig: 'test-key;https://telemetry.n8n.io' },
	});

	let controller: TelemetryController;

	beforeEach(() => {
		controller = new TelemetryController(globalConfig);
	});

	const makeRes = () => {
		const res = mock<Response>();
		res.status.mockReturnValue(res);
		return res;
	};

	describe('CORS', () => {
		it('allows any origin and reflects the requested headers on preflight', () => {
			const req = mock<AuthenticatedRequest>({
				headers: { 'access-control-request-headers': 'anonymousid,authorization,content-type' },
			});
			const res = makeRes();

			controller.proxyPreflight(req, res);

			expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
			expect(res.setHeader).toHaveBeenCalledWith(
				'Access-Control-Allow-Methods',
				'GET, POST, OPTIONS',
			);
			expect(res.setHeader).toHaveBeenCalledWith(
				'Access-Control-Allow-Headers',
				'anonymousid,authorization,content-type',
			);
			expect(res.status).toHaveBeenCalledWith(204);
		});

		it('falls back to a static allow-list when no headers are requested', () => {
			const req = mock<AuthenticatedRequest>({ headers: {} });
			const res = makeRes();

			controller.proxyPreflight(req, res);

			expect(res.setHeader).toHaveBeenCalledWith(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, anonymousId',
			);
		});

		// Security invariant: `Access-Control-Allow-Origin: *` must never be paired
		// with credentials. If this ever fails, the change is unsafe — do not "fix"
		// the test, fix the code.
		it('never allows credentials', () => {
			const req = mock<AuthenticatedRequest>({ headers: {} });
			const res = makeRes();

			controller.proxyPreflight(req, res);

			expect(res.setHeader).not.toHaveBeenCalledWith(
				'Access-Control-Allow-Credentials',
				expect.anything(),
			);
			expect(res.removeHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials');
		});

		it('applies CORS on the proxied track endpoint before forwarding', async () => {
			const proxy = jest.fn().mockResolvedValue(undefined);
			controller.proxy = proxy as unknown as typeof controller.proxy;

			const req = mock<AuthenticatedRequest>({ headers: {} });
			const res = makeRes();
			const next = jest.fn() as unknown as NextFunction;

			await controller.track(req, res, next);

			expect(res.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*');
			expect(res.removeHeader).toHaveBeenCalledWith('Access-Control-Allow-Credentials');
			expect(res.setHeader).not.toHaveBeenCalledWith(
				'Access-Control-Allow-Credentials',
				expect.anything(),
			);
			expect(proxy).toHaveBeenCalledWith(req, res, next);
		});
	});
});
