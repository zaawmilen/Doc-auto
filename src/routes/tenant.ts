import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { updateTenantSchema } from '../validators/tenant.js';
import * as TenantService from '../services/tenant.service.js';

const router = Router();

router.get('/', requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await TenantService.getTenantConfig(req.user!.tenantId);
      res.status(200).json({ tenant: config });
    } catch (err) { next(err); }
  }
);

router.patch('/', requireAuth, requireRole('admin'), validate(updateTenantSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body as { name?: string; extractionThreshold?: number; webhookUrl?: string | null };
      const config = await TenantService.updateTenantConfig({
        tenantId: req.user!.tenantId,
        ...body,
      });
      res.status(200).json({ tenant: config });
    } catch (err) { next(err); }
  }
);

router.post('/webhook-secret/rotate', requireAuth, requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await TenantService.rotateWebhookSecret(req.user!.tenantId);
      res.status(200).json(result);
    } catch (err) { next(err); }
  }
);

export { router as tenantRouter };
