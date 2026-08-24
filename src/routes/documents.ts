import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import {
  listDocumentsSchema,
  documentIdParamSchema,
  rejectDocumentSchema,
  editExtractionSchema,
  reprocessDocumentSchema,
  ALLOWED_MIME_TYPES,
} from '../validators/documents.js';
import * as DocumentService from '../services/document.service.js';
import { AppError } from '../lib/errors.js';
import { env } from '../config/env.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`));
    }
    cb(null, true);
  },
});

// multer surfaces both file-size-limit and fileFilter rejections as plain
// Errors passed straight to next(), which errorHandler.ts treats as an
// unexpected 500 since they aren't AppError instances. Wrap it so both
// cases become the 400 they actually are.
function handleUpload(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(AppError.badRequest(`File exceeds the maximum upload size of ${env.MAX_UPLOAD_BYTES} bytes`, 'FILE_TOO_LARGE'));
    }
    if (err instanceof Error) {
      return next(AppError.badRequest(err.message, 'UNSUPPORTED_FILE_TYPE'));
    }
    return next(err);
  });
}

router.post('/', requireAuth, handleUpload,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) throw AppError.badRequest('No file provided — use multipart field name "file"');
      const document = await DocumentService.uploadNewDocument({
        tenantId: req.user!.tenantId,
        uploadedBy: req.user!.sub,
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
        correlationId: req.correlationId,
      });
      res.status(201).json({ document });
    } catch (err) { next(err); }
  }
);

router.get('/', requireAuth, validate(listDocumentsSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, page, pageSize } = req.query as unknown as { status?: string; page: number; pageSize: number };
      const result = await DocumentService.listDocuments({
        tenantId: req.user!.tenantId,
        ...(status !== undefined && { status }),
        page,
        pageSize,
      });
      res.status(200).json(result);
    } catch (err) { next(err); }
  }
);

router.get('/:id', requireAuth, validate(documentIdParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = await DocumentService.getDocumentWithAudit({ tenantId: req.user!.tenantId, documentId: req.params.id as string });
      res.status(200).json({ document });
    } catch (err) { next(err); }
  }
);

router.get('/:id/file', requireAuth, validate(documentIdParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await DocumentService.getDocumentFileUrl({ tenantId: req.user!.tenantId, documentId: req.params.id as string });
      res.status(200).json(result);
    } catch (err) { next(err); }
  }
);

router.post('/:id/approve', requireAuth, requireRole('admin', 'reviewer'), validate(documentIdParamSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = await DocumentService.approveDocument({
        tenantId: req.user!.tenantId,
        documentId: req.params.id as string,
        actorId: req.user!.sub,
      });
      res.status(200).json({ document });
    } catch (err) { next(err); }
  }
);

router.post('/:id/reject', requireAuth, requireRole('admin', 'reviewer'), validate(rejectDocumentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = await DocumentService.rejectDocument({
        tenantId: req.user!.tenantId,
        documentId: req.params.id as string,
        actorId: req.user!.sub,
        reason: (req.body as { reason: string }).reason,
      });
      res.status(200).json({ document });
    } catch (err) { next(err); }
  }
);

router.patch('/:id/extraction', requireAuth, requireRole('admin', 'reviewer'), validate(editExtractionSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const extraction = await DocumentService.editDocumentExtraction({
        tenantId: req.user!.tenantId,
        documentId: req.params.id as string,
        actorId: req.user!.sub,
        changes: req.body,
      });
      res.status(200).json({ extraction });
    } catch (err) { next(err); }
  }
);

router.post('/:id/reprocess', requireAuth, requireRole('admin', 'reviewer'), validate(reprocessDocumentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const document = await DocumentService.reprocessDocument({
        tenantId: req.user!.tenantId,
        documentId: req.params.id as string,
        actorId: req.user!.sub,
      });
      res.status(202).json({ document });
    } catch (err) { next(err); }
  }
);

export { router as documentsRouter };
