// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { normalizeOperationOutcome } from '@medplum/core';
import type { Attachment, OperationOutcome, Reference } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react-hooks';
import type { ChangeEvent, JSX, MouseEvent, ReactNode } from 'react';
import { useId, useImperativeHandle, useRef } from 'react';
import { killEvent } from '../utils/dom';

export interface AttachmentButtonProps {
  readonly securityContext?: Reference;
  readonly onUpload: (attachment: Attachment) => void;
  readonly onUploadStart?: () => void;
  readonly onUploadProgress?: (e: ProgressEvent) => void;
  readonly onUploadError?: (outcome: OperationOutcome) => void;
  children(props: { disabled?: boolean; onClick(e: MouseEvent): void; fileInputId?: string }): ReactNode;
  readonly disabled?: boolean;
  /** Ref to trigger the file input programmatically (e.g. from a remote button) */
  readonly triggerRef?: React.Ref<{ trigger: () => void }>;
}

export function AttachmentButton(props: AttachmentButtonProps): JSX.Element {
  const medplum = useMedplum();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();

  useImperativeHandle(props.triggerRef, () => ({ trigger: () => fileInputRef.current?.click() }), []);

  function onClick(e: MouseEvent): void {
    killEvent(e);
    fileInputRef.current?.click();
  }

  function onFileChange(e: ChangeEvent): void {
    killEvent(e);
    const input = e.target as HTMLInputElement;
    const files = input.files;
    if (files) {
      Array.from(files).forEach(processFile);
    }
    // Allow selecting the same file(s) again in a subsequent pick.
    input.value = '';
  }

  /**
   * Processes a single file.
   * @param file - The file descriptor.
   */
  function processFile(file: File): void {
    if (!file) {
      return;
    }

    const fileName = file.name;
    if (!fileName) {
      return;
    }

    if (props.onUploadStart) {
      props.onUploadStart();
    }

    medplum
      .createAttachment({
        data: file,
        contentType: file.type || 'application/octet-stream',
        filename: file.name,
        securityContext: props.securityContext,
        onProgress: props.onUploadProgress,
      })
      .then((attachment: Attachment) => props.onUpload(attachment))
      .catch((err) => {
        if (props.onUploadError) {
          props.onUploadError(normalizeOperationOutcome(err));
        }
      });
  }

  return (
    <>
      <input
        id={fileInputId}
        disabled={props.disabled}
        type="file"
        multiple
        accept="*/*"
        data-testid="upload-file-input"
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden', clip: 'rect(0,0,0,0)', clipPath: 'inset(50%)' }}
        ref={fileInputRef}
        onChange={(e) => onFileChange(e)}
      />
      {props.children({ onClick, disabled: props.disabled, fileInputId })}
    </>
  );
}
