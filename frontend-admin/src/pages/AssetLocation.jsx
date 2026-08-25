import { useState, useEffect, useMemo, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { fetchAssetLocations, fetchLocationsList, fetchEmployeesList, requestCustodyChange } from '../api';
import { colors } from '../theme';
import { canChangeAssets } from '../roles';

function currentUser() {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
}

// Pins are coloured by condition so a branch full of faulty kit is visible
// without clicking anything. Built as divIcons rather than image files: no
// extra assets to host, and the colour comes straight from the theme.
const CONDITION_COLORS = {
  'Good': colors.success,
  'Good with issues': colors.warning,
  'Faulty': colors.danger,
};
const UNKNOWN_COLOR = '#8a8a8a';

function conditionColor(condition) {
  return CONDITION_COLORS[condition] || UNKNOWN_COLOR;
}

// Cached — Leaflet re-renders markers often and rebuilding the DOM string for
// every pin on every pan is wasteful.
const iconCache = new Map();

function pinIcon(condition) {
  const color = conditionColor(condition);
  if (iconCache.has(color)) return iconCache.get(color);

  const icon = L.divIcon({
    className: '',
    html: `<div style="
      width:18px;height:18px;border-radius:50% 50% 50% 0;
      background:${color};border:2px solid #fff;
      transform:rotate(-45deg);
      box-shadow:0 1px 4px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 18],
    popupAnchor: [0, -18],
  });
  iconCache.set(color, icon);
  return icon;
}

// An asset's condition comes from its latest verification when we have one,
// otherwise from the asset record itself.
function assetCondition(a) {
  return a.verified_condition || a.asset_condition || null;
}

// Nairobi, Kenya — sensible default center when there's no data yet.
const DEFAULT_CENTER = [-1.2921, 36.8219];

export default function AssetLocations({ onSelectAsset }) {
  const [assets, setAssets] = useState([]);
  const [locations, setLocations] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const me = currentUser();
  const canAssign = canChangeAssets(me);

  const loadAssets = useCallback(
    () => fetchAssetLocations({ verifiedOnly }).then(setAssets),
    [verifiedOnly]
  );

  // Reference data (branches, people) doesn't change with the toggle, so it is
  // fetched once rather than on every switch.
  useEffect(() => {
    Promise.all([
      fetchLocationsList().then(setLocations),
      fetchEmployeesList().then(setEmployees),
    ]).catch(() => setError('Failed to load branches and employees.'));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    loadAssets()
      .catch(() => setError('Failed to load asset locations.'))
      .finally(() => setLoading(false));
  }, [loadAssets]);

  const filtered = useMemo(() => {
    if (!search.trim()) return assets;
    const q = search.trim().toLowerCase();
    return assets.filter(
      (a) =>
        a.asset_code.toLowerCase().includes(q) ||
        (a.description || '').toLowerCase().includes(q) ||
        (a.current_holder || '').toLowerCase().includes(q) ||
        (a.current_branch || '').toLowerCase().includes(q)
    );
  }, [assets, search]);

  const center = filtered.length > 0
    ? [Number(filtered[0].latitude), Number(filtered[0].longitude)]
    : DEFAULT_CENTER;

  if (loading) return <div style={{ padding: 30 }}>Loading asset locations...</div>;
  if (error) return <div style={{ padding: 30, color: colors.danger }}>{error}</div>;

  return (
    <div style={{ padding: 30, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h1 style={{ color: colors.ink, margin: 0 }}>Asset Locations</h1>
          <p style={{ color: colors.grayText, margin: '4px 0 0', fontSize: 13 }}>
            {assets.length} asset{assets.length === 1 ? '' : 's'}{' '}
            {verifiedOnly
              ? 'physically verified by an officer on site'
              : 'with a recorded GPS location (last scan, transfer, or verification)'}.
            {canAssign ? ' Click a pin to reassign branch or holder.' : ''}
          </p>
        </div>
        <input
          placeholder="Search asset code, holder, branch..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={searchInputStyle}
        />
      </div>

      <div style={controlRowStyle}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: colors.ink }}>
          <input
            type="checkbox"
            checked={verifiedOnly}
            onChange={(e) => setVerifiedOnly(e.target.checked)}
          />
          Verified assets only
        </label>

        <div style={{ display: 'flex', gap: 14, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {['Good', 'Good with issues', 'Faulty'].map((c) => (
            <span key={c} style={legendItemStyle}>
              <span style={{ ...legendDotStyle, background: conditionColor(c) }} />
              {c}
            </span>
          ))}
          <span style={legendItemStyle}>
            <span style={{ ...legendDotStyle, background: UNKNOWN_COLOR }} />
            Not yet verified
          </span>
        </div>
      </div>

      {assets.length === 0 ? (
        <div style={{ ...panelStyle, textAlign: 'center', color: colors.grayText }}>
          {verifiedOnly
            ? 'No assets have been physically verified with location yet. Officers capture a position each time they verify an asset in the mobile app. Untick "Verified assets only" to see positions from scans and transfers as well.'
            : 'No assets have a recorded GPS location yet. Locations are captured automatically when staff scan, assign, check in, or verify an asset in the mobile app (with location permission granted).'}
        </div>
      ) : (
        <div style={{ ...panelStyle, padding: 0, overflow: 'hidden' }}>
          <MapContainer center={center} zoom={filtered.length > 0 ? 7 : 6} style={{ height: 560, width: '100%' }}>
            <TileLayer
              attribution='&copy; OpenStreetMap contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {filtered.map((a) => (
              <Marker
                key={a.id}
                position={[Number(a.latitude), Number(a.longitude)]}
                icon={pinIcon(assetCondition(a))}
              >
                <Popup minWidth={220}>
                  <AssetPopupContent
                    asset={a}
                    locations={locations}
                    employees={employees}
                    canAssign={canAssign}
                    onSelectAsset={onSelectAsset}
                    onAssigned={loadAssets}
                  />
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      )}
    </div>
  );
}

function AssetPopupContent({ asset, locations, employees, canAssign, onSelectAsset, onAssigned }) {
  const [locationId, setLocationId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [condition, setCondition] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

    // The backend requires a condition when equipment goes to a person — that
  // record is what makes HR 9.3b enforceable if it comes back damaged. Moving
  // an asset to a location doesn't need one.
  const handleAssign = async () => {
    if (!locationId && !employeeId) {
      setMessage('Pick a branch or a person first.');
      return;
    }
    if (employeeId && !condition) {
      setMessage('Record the condition it is being handed over in.');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      await requestCustodyChange({
        asset_id: asset.id,
        kind: 'assign',
        location_id: locationId || null,
        employee_id: employeeId || null,
        condition: employeeId ? condition : null,
        latitude: asset.latitude,
        longitude: asset.longitude,
      });
      setMessage('Requested. An Admin must approve it before it takes effect.');
      await onAssigned();
    } catch (err) {
      setMessage(err.response?.data?.error || 'Failed to request the change.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ fontSize: 13, minWidth: 200 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{asset.asset_code}</div>
      <div style={{ marginBottom: 4 }}>{asset.description}</div>
      <div style={{ color: '#666' }}>Status: {asset.status}</div>
      <div style={{ color: '#666' }}>
        Condition:{' '}
        <span style={{ color: conditionColor(assetCondition(asset)), fontWeight: 600 }}>
          {assetCondition(asset) || 'Not yet verified'}
        </span>
      </div>
      {asset.current_holder && <div style={{ color: '#666' }}>Holder: {asset.current_holder}</div>}
      {asset.current_branch && <div style={{ color: '#666' }}>Branch: {asset.current_branch}</div>}
      <div style={{ color: '#999', marginTop: 4, fontSize: 11 }}>
        {asset.source === 'Verification' ? 'Verified' : `Last ${(asset.source || 'recorded').toLowerCase()}`}{' '}
        {new Date(asset.recorded_at).toLocaleString()}
      </div>

      {/* Read-only roles used to see this whole form, pick a branch and a
          person, and only then get a 403 from the backend. */}
      {canAssign && (
        <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 8 }}>
          <label style={popupLabelStyle}>Move to branch</label>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            style={popupSelectStyle}
          >
            <option value="">— No change —</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>{l.branch}{l.physical_location ? ' - ' + l.physical_location : ''}</option>
            ))}
          </select>

                   <label style={popupLabelStyle}>Assign to</label>
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            style={popupSelectStyle}
          >
            <option value="">— No change —</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>

          {/* Required by the backend when equipment goes to a person: that
              record is what makes HR 9.3b enforceable if it comes back
              damaged. Shown only for a person, since moving an asset to a
              location does not need one. */}
          {employeeId && (
            <>
              <label style={popupLabelStyle}>Condition at handover</label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
                style={popupSelectStyle}
              >
                <option value="">— Select —</option>
                <option value="Good">Good</option>
                <option value="Good with issues">Good with issues</option>
                <option value="Faulty">Faulty</option>
              </select>
            </>
          )}

          {/* "Request", not "Save": this no longer writes to the register. An
              Admin reviews it on the Approvals page first. */}
          <button
            onClick={handleAssign}
            disabled={saving}
            style={{ marginTop: 6, width: '100%', padding: '5px 10px', background: colors.primary, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
          >
            {saving ? 'Sending...' : 'Request Change'}
          </button>
          {message && <div style={{ marginTop: 6, fontSize: 11, color: message.startsWith('Requested') ? colors.success : colors.danger }}>{message}</div>}
        </div>
      )}

      {onSelectAsset && (
        <button
          onClick={() => onSelectAsset(asset.asset_code)}
          style={{ marginTop: 8, width: '100%', padding: '4px 10px', background: colors.black, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}
        >
          View Details
        </button>
      )}
    </div>
  );
}

const controlRowStyle = {
  display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
  marginBottom: 12, padding: '10px 14px',
  background: colors.gray, borderRadius: 8,
};
const legendItemStyle = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: colors.grayText,
};
const legendDotStyle = {
  width: 10, height: 10, borderRadius: '50%', display: 'inline-block',
};
const panelStyle = { background: colors.white, borderRadius: 10, padding: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' };
const searchInputStyle = {
  padding: '8px 12px', borderRadius: 6, border: '1px solid ' + colors.border, fontSize: 13, minWidth: 260,
};
const popupLabelStyle = { display: 'block', fontSize: 11, color: '#888', marginTop: 6, marginBottom: 2 };
const popupSelectStyle = { width: '100%', padding: '4px 6px', fontSize: 12, borderRadius: 4, border: '1px solid #ddd', boxSizing: 'border-box' };