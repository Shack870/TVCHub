import { Modal } from './Modal';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} width="max-w-sm">
      <div className="legal-pad rounded-lg p-6 pl-14 shadow-card">
        <h3 className="font-hand text-3xl ink">{title}</h3>
        <p className="mt-2 font-type text-sm text-pad-ink">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost text-pad-ink" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            className={tone === 'danger' ? 'btn-danger' : 'btn-primary'}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
