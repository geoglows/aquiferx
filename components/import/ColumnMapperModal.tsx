import React from 'react';
import { UploadedFile, DATE_FORMATS } from '../../services/importUtils';

interface FieldDefinition {
  key: string;
  label: string;
  required: boolean;
}

interface ColumnMapperModalProps {
  file: UploadedFile;
  fieldDefinitions: FieldDefinition[];
  onUpdateMapping: (targetColumn: string, sourceColumn: string) => void;
  onClose: () => void;
  dateFormat?: string;
  onDateFormatChange?: (format: string) => void;
  title?: string;
}

const ColumnMapperModal: React.FC<ColumnMapperModalProps> = ({
  file,
  fieldDefinitions,
  onUpdateMapping,
  onClose,
  dateFormat,
  onDateFormatChange,
  title = 'Map Columns'
}) => {
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 bg-slate-900/60" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-slate-800 mb-4">{title}</h3>
        <p className="text-sm text-slate-500 mb-4">
          Map your file columns to the required fields. File: {file.name}
        </p>

        <div className="space-y-3 mb-6">
          {fieldDefinitions.map(col => (
            <div key={col.key} className="flex items-center space-x-3">
              <label className="w-40 text-sm font-medium text-slate-700">
                {col.label}
                {col.required && <span className="text-red-500 ml-1">*</span>}
              </label>
              <select
                value={file.mapping[col.key] || ''}
                onChange={(e) => onUpdateMapping(col.key, e.target.value)}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">-- Select Column --</option>
                {file.columns.map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
          ))}

          {dateFormat !== undefined && onDateFormatChange && (
            <div className="flex items-center space-x-3 pt-2 border-t">
              <label className="w-40 text-sm font-medium text-slate-700">
                Date Format
              </label>
              <select
                value={dateFormat}
                onChange={(e) => onDateFormatChange(e.target.value)}
                className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {DATE_FORMATS.map(f => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 text-white rounded-lg font-medium text-sm hover:bg-slate-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default ColumnMapperModal;
