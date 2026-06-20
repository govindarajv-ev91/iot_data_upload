/** Upload templates and column headers per IoT data source. */

export const IOT_SOURCE_TEMPLATES = {
  opspod_ev91: {
    label: 'Opspod-ev91',
    templateFile: 'opspod_ev91_template.csv',
    requiredFields: {
      vehicle: 'Object',
      date: 'Date',
      distance: 'Total Distance',
    },
    headers: ['ID Name', 'Object', 'Object Brand', 'Object Model', 'Total Distance', 'Date'],
    sampleRow: ['Sample ID', 'TN22EB2091', 'Brand', 'Model', '45.5', '2026-06-18'],
  },
  alt_mobility: {
    label: 'Alt Mobility',
    templateFile: 'alt_mobility_template.csv',
    requiredFields: {
      vehicle: 'reg_no',
      date: 'Total Distance Date',
      distance: 'total_distance',
    },
    headers: [
      'vehicle_id',
      'reg_no',
      'manufacturer_name',
      'model_name',
      'customer_name',
      'tranche',
      'city',
      'connectivity_status',
      'substatus',
      'asset_type',
      'asset_category',
      'vehicle_category',
      'total_distance',
      'extra_km_charge_per_km',
      'permitted_monthly_km',
      'average_km_per_soc',
      'average_wh_per_km',
      'Total Distance Date',
    ],
    sampleRow: [
      'V001',
      'TN22EB2091',
      'OEM',
      'Model X',
      'Customer',
      'T1',
      'Chennai',
      'Connected',
      'Active',
      'EV',
      '2W',
      'Bike',
      '52',
      '0',
      '3000',
      '1.2',
      '28',
      '2026-06-18',
    ],
  },
  vehicle_day_report: {
    label: 'Recent_Details (stridegreen)',
    templateFile: 'vehicle_day_report_template.csv',
    requiredFields: {
      vehicle: 'Vehicle No',
      date: 'Date',
      distance: 'Distance (km)',
    },
    headers: [
      'S.No.',
      'Date',
      'Vehicle No',
      'Chassis No',
      'City',
      'Age (Months)',
      'OEM',
      'Model',
      'Distance (km)',
    ],
    sampleRow: ['1', '2026-06-18', 'TN22EB2091', 'P6DEC12NPCA009459', 'Chennai', '12', 'OEM', 'Model', '38'],
  },
  Recent_Details: {
    label: 'vehicle_day_report (Motvolt)',
    templateFile: 'Recent_Details_template.csv',
    requiredFields: {
      vehicle: 'Reg No',
      date: 'Report Date',
      distance: 'Distance',
    },
    headers: ['Reg No', 'Vin', 'Vcu Id', 'Report Date', 'Distance'],
    sampleRow: ['TN22EB2091', 'P6DEC12NPCA009459', 'VCU001', '2026-06-18', '45'],
  },
}

export function getTemplateUrl(sourceKey) {
  const cfg = IOT_SOURCE_TEMPLATES[sourceKey]
  if (!cfg) return ''
  return `/templates/${cfg.templateFile}`
}

export function isRequiredHeader(sourceKey, header) {
  const cfg = IOT_SOURCE_TEMPLATES[sourceKey]
  if (!cfg) return false
  const required = Object.values(cfg.requiredFields)
  return required.includes(header)
}
