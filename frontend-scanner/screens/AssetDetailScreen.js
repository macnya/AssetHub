import { useState, useMemo } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, Linking,
} from 'react-native';
import { requestCustodyOffline } from '../offline/offlineApi';
import AssignModal from './AssignModal';
import VerifyModal from './VerifyModal';
import * as Location from 'expo-location';
import { c, mono, conditionColor, EVENT_COLORS } from '../theme';

// Bar widths lifted from the app icon, so the tag on screen and the icon on
// the home screen are recognisably the same mark.
const BARCODE = [4, 2, 3, 6, 2, 3, 2, 5, 3, 2, 4, 2, 6, 3, 2, 5];

// Walks the trail oldest-first and turns it into spells of custody: who held
// the asset, from when, until when. Derived from the timeline rather than a
// separate query, so it costs nothing and works offline.
function buildHolderHistory(timeline) {
  if (!Array.isArray(timeline)) return [];
  const chronological = [...timeline].reverse();
  const spells = [];
  let current = null;

  for (const e of chronological) {
    if (e.type === 'Verification') continue;   // inspections don't change custody
    const receiver = e.to_holder || e.to_place || e.to_branch;

    if (current && current.name !== receiver) {
      current.until = e.at;
      current = null;
    }
    if (receiver && !current) {
      current = { name: receiver, isPerson: !!e.to_holder, since: e.at, until: null, by: e.actor };
      spells.push(current);
    }
  }
  return spells.reverse();
}

export default function AssetDetailScreen({ assetData, onBack, onRefresh }) {
  const { asset, current_assignment, last_seen, last_holder, timeline, pendingSync } = assetData;
  const [showAll, setShowAll] = useState(false);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);

  const holders = useMemo(() => buildHolderHistory(timeline), [timeline]);
  const events = Array.isArray(timeline) ? timeline : [];
  const shown = showAll ? events : events.slice(0, 4);

  const performCheckIn = async () => {
    setCheckingIn(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      let latitude = null, longitude = null;
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        latitude = loc.coords.latitude;
        longitude = loc.coords.longitude;
      }
      // A request, not a return. Custody moves only once an administrator has
      // approved it, so the asset is still with its current holder until then.
      const result = await requestCustodyOffline(asset.asset_code, {
        asset_id: asset.id,
        kind: 'return',
        latitude,
        longitude,
      });

      Alert.alert(
        result.queued ? 'Saved offline' : 'Recorded',
        result.queued
          ? "Saved on this phone. It will be sent once you're back online."
          : result.message || `The return of ${asset.asset_code} has been recorded for approval.`,
        [{ text: 'OK', onPress: onBack }]
      );
    } catch (err) {
      Alert.alert('Could not return this asset', err.response?.data?.error || 'Try again once you have a signal.');
    } finally {
      setCheckingIn(false);
    }
  };

  const handleCheckIn = () => {
    if (!current_assignment) return;
    const holder = current_assignment.employee_name || current_assignment.physical_location || current_assignment.branch || 'its current holder';
    Alert.alert(
      'Return to storage?',
      `A request will be recorded to clear ${asset.asset_code} from ${holder}. ` +
      `An administrator approves it before the register changes.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Request return', onPress: performCheckIn },
      ]
    );
  };

  const done = (verb) => (result) => {
    setShowAssignModal(false);
    setShowVerifyModal(false);

    // The backend returns its own message when something needs approval, because
    // what happened depends on the workflow rather than the action. Telling an
    // officer the register was updated when it is waiting for review is worse
    // than saying nothing — one asset was verified three times in six minutes
    // because the officer had no way to tell the first attempt had worked.
    const title = result?.queued ? 'Saved offline'
                : result?.message ? 'Recorded'
                : verb;

    const body = result?.queued
      ? "Saved on this phone. It will sync once you're back online."
      : result?.message || `${asset.asset_code} updated.`;

    Alert.alert(title, body, [
      { text: 'OK', onPress: verb === 'Verified' ? onRefresh : onBack },
    ]);
  };

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <TouchableOpacity onPress={onBack} style={s.backButton} activeOpacity={0.6}>
          <Text style={s.backChevron}>‹</Text>
          <Text style={s.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Asset</Text>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollInner} showsVerticalScrollIndicator={false}>
        {pendingSync && (
          <View style={s.offlineNote}>
            <Text style={s.offlineNoteText}>Offline copy — some changes not yet synced</Text>
          </View>
        )}

        {/* The tag. This is what the officer holds against the sticker on the
            equipment, so it gets the weight and the mono setting. */}
        <View style={s.tag}>
          <Text style={s.eyebrow}>{asset.category_name || 'Asset'}</Text>
          <Text style={s.code}>{asset.asset_code}</Text>

          <View style={s.barcode}>
            {BARCODE.map((w, i) => (
              <View key={i} style={[s.bar, { width: w * 2, marginRight: i === BARCODE.length - 1 ? 0 : 3 }]} />
            ))}
          </View>

          <Text style={s.assetName}>{asset.description}</Text>

          <View style={s.chips}>
            <View style={[s.chip, { borderColor: c.rule }]}>
              <Text style={s.chipLabel}>Status</Text>
              <Text style={s.chipValue}>{asset.status}</Text>
            </View>
            <View style={[s.chip, { borderColor: conditionColor(asset.condition) }]}>
              <Text style={s.chipLabel}>Condition</Text>
              <Text style={[s.chipValue, { color: conditionColor(asset.condition) }]}>
                {asset.condition || 'Not verified'}
              </Text>
            </View>
          </View>
        </View>

        {/* Custody: who has it now, and everyone who had it before. One
            question, one card — this used to be spread across three. */}
        <Section title="Custody">
          {current_assignment ? (
            <View style={s.holderNow}>
              <Text style={s.holderNowName}>
                {current_assignment.employee_name || current_assignment.physical_location || current_assignment.branch}
              </Text>
              <Text style={s.holderNowMeta}>
                {[current_assignment.branch, current_assignment.physical_location, current_assignment.employee_department]
                  .filter(Boolean).join(' · ')}
              </Text>
            </View>
          ) : (
            <View style={s.holderNow}>
              <Text style={[s.holderNowName, { color: c.inkSoft }]}>In storage</Text>
              {last_holder && (
                <Text style={s.holderNowMeta}>
                  Last held by {last_holder.employee_name || last_holder.branch || 'unknown'}
                  {last_holder.returned_date ? `, returned ${new Date(last_holder.returned_date).toLocaleDateString()}` : ''}
                </Text>
              )}
            </View>
          )}

          {holders.length > 0 && (
            <>
              <Text style={s.subhead}>Held by</Text>
              {holders.map((h, i) => (
                <View key={`${h.name}-${h.since}-${i}`} style={s.holderRow}>
                  <View style={[s.holderDot, { backgroundColor: h.until ? c.rule : c.good }]} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.holderName}>{h.name}</Text>
                    <Text style={s.holderMeta}>
                      {new Date(h.since).toLocaleDateString()}
                      {h.until ? ` – ${new Date(h.until).toLocaleDateString()}` : ' – now'}
                      {h.by ? `  ·  by ${h.by}` : ''}
                    </Text>
                  </View>
                </View>
              ))}
            </>
          )}

          {last_seen && (
            <TouchableOpacity style={s.seen} onPress={() => Linking.openURL(last_seen.map_url)}>
              <Text style={s.seenText}>
                Last seen {new Date(last_seen.recorded_at).toLocaleDateString()} during {last_seen.source.toLowerCase()}
              </Text>
              <Text style={s.seenLink}>Map ›</Text>
            </TouchableOpacity>
          )}
        </Section>

        <Section title="Details">
          <Row label="Serial" value={asset.serial_number} mono />
          {asset.chassis_number ? <Row label="Chassis" value={asset.chassis_number} mono /> : null}
          {asset.engine_number ? <Row label="Engine" value={asset.engine_number} mono /> : null}
          <Row label="Purchase price" value={asset.purchase_price ? `KES ${Number(asset.purchase_price).toLocaleString()}` : null} />
        </Section>

        {/* A real sequence, so it gets a real timeline: one rail, events
            hanging off it, newest first. */}
        <Section title={`Activity${events.length ? ` · ${events.length}` : ''}`}>
          {events.length === 0 ? (
            <Text style={s.empty}>Nothing recorded yet. Assign or verify this asset and it will show up here.</Text>
          ) : (
            <>
              <View style={s.rail}>
                {shown.map((e, i) => (
                  <Event key={e.event_id} event={e} last={i === shown.length - 1} />
                ))}
              </View>
              {events.length > 4 && (
                <TouchableOpacity style={s.more} onPress={() => setShowAll((v) => !v)}>
                  <Text style={s.moreText}>{showAll ? 'Show less' : `Show all ${events.length}`}</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </Section>
      </ScrollView>

      <View style={s.actions}>
        <TouchableOpacity style={s.primary} onPress={() => setShowVerifyModal(true)}>
          <Text style={s.primaryText}>Verify</Text>
        </TouchableOpacity>

        {current_assignment ? (
          <TouchableOpacity style={s.secondary} onPress={handleCheckIn} disabled={checkingIn}>
            {checkingIn
              ? <ActivityIndicator color={c.deep} />
              : <Text style={s.secondaryText}>Return to storage</Text>}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.secondary} onPress={() => setShowAssignModal(true)}>
            <Text style={s.secondaryText}>Assign</Text>
          </TouchableOpacity>
        )}
      </View>

      <AssignModal
        visible={showAssignModal}
        assetCode={asset.asset_code}
        assetId={asset.id}
        onClose={() => setShowAssignModal(false)}
        onAssigned={done('Assigned')}
      />
      <VerifyModal
        visible={showVerifyModal}
        assetCode={asset.asset_code}
        onClose={() => setShowVerifyModal(false)}
        onVerified={done('Verified')}
      />
    </View>
  );
}

function Section({ title, children }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, mono: isMono }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, isMono && s.rowValueMono]} numberOfLines={2}>{value ?? '—'}</Text>
    </View>
  );
}

function Event({ event, last }) {
  const color = EVENT_COLORS[event.type] || c.inkFaint;
  const from = event.from_holder || event.from_place || event.from_branch;
  const to = event.to_holder || event.to_place || event.to_branch;

  return (
    <View style={s.event}>
      <View style={s.eventGutter}>
        <View style={[s.eventDot, { borderColor: color }]} />
        {!last && <View style={s.eventLine} />}
      </View>

      <View style={s.eventBody}>
        <View style={s.eventTop}>
          <Text style={[s.eventType, { color }]}>{event.type}</Text>
          <Text style={s.eventDate}>
            {new Date(event.at).toLocaleDateString()}
          </Text>
        </View>

        <Text style={s.eventText}>
          {event.type === 'Verification' ? (
            <>
              {event.actor || 'Someone'} recorded it as{' '}
              <Text style={{ color: conditionColor(event.condition), fontWeight: '700' }}>
                {event.condition || 'unknown'}
              </Text>
            </>
          ) : (
            <>
              {from ? `From ${from} ` : ''}{to ? `to ${to} ` : ''}
              {!from && !to ? 'Recorded ' : ''}by {event.actor || 'unknown'}
            </>
          )}
        </Text>

        {event.remarks ? <Text style={s.eventRemarks}>{event.remarks}</Text> : null}

        {event.map_url ? (
          <TouchableOpacity onPress={() => Linking.openURL(event.map_url)}>
            <Text style={s.eventLink}>Map ›</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.surface },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 4,
    backgroundColor: c.paper, borderBottomWidth: 1, borderBottomColor: c.rule,
  },
  // ~90x44 tap target. A bare chevron was too small to hit reliably.
  backButton: {
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 6, paddingRight: 14, paddingVertical: 10,
  },
  backChevron: { fontSize: 30, lineHeight: 32, color: c.deep, fontWeight: '300', marginRight: 2 },
  backLabel: { fontSize: 16, color: c.deep, fontWeight: '600' },
  headerTitle: { fontSize: 13, fontWeight: '600', color: c.inkSoft, letterSpacing: 0.4 },

  scroll: { flex: 1 },
  scrollInner: { padding: 16, paddingBottom: 28 },

  offlineNote: {
    backgroundColor: '#FFF4E5', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, marginBottom: 14,
    borderWidth: 1, borderColor: '#F5D9AE',
  },
  offlineNoteText: { color: '#8A5A00', fontSize: 12, textAlign: 'center', fontWeight: '500' },

  tag: {
    backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.rule,
    paddingVertical: 20, paddingHorizontal: 18, marginBottom: 14, alignItems: 'center',
  },
  eyebrow: {
    fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase',
    color: c.inkFaint, fontWeight: '700', marginBottom: 8,
  },
  code: { fontFamily: mono, fontSize: 30, letterSpacing: 1.5, color: c.ink, fontWeight: '700' },
  barcode: { flexDirection: 'row', alignItems: 'flex-end', height: 26, marginTop: 12, marginBottom: 14 },
  bar: { height: 26, backgroundColor: c.ink, borderRadius: 0.5 },
  assetName: { fontSize: 15, color: c.inkSoft, textAlign: 'center', lineHeight: 21 },

  chips: { flexDirection: 'row', gap: 10, marginTop: 16, alignSelf: 'stretch' },
  chip: { flex: 1, borderWidth: 1.5, borderRadius: 10, paddingVertical: 9, paddingHorizontal: 12 },
  chipLabel: {
    fontSize: 9, letterSpacing: 1.1, textTransform: 'uppercase',
    color: c.inkFaint, fontWeight: '700', marginBottom: 3,
  },
  chipValue: { fontSize: 14, fontWeight: '700', color: c.ink },

  section: {
    backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.rule,
    padding: 16, marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase',
    color: c.inkFaint, fontWeight: '700', marginBottom: 12,
  },
  subhead: {
    fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase',
    color: c.inkFaint, fontWeight: '700', marginTop: 16, marginBottom: 8,
  },

  holderNow: { paddingBottom: 2 },
  holderNowName: { fontSize: 19, fontWeight: '700', color: c.ink },
  holderNowMeta: { fontSize: 13, color: c.inkSoft, marginTop: 3, lineHeight: 18 },

  holderRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 6 },
  holderDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, marginRight: 11 },
  holderName: { fontSize: 14, fontWeight: '600', color: c.ink },
  holderMeta: { fontSize: 12, color: c.inkFaint, marginTop: 1 },

  seen: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: c.rule,
  },
  seenText: { fontSize: 12, color: c.inkSoft, flex: 1 },
  seenLink: { fontSize: 12, color: c.deep, fontWeight: '700' },

  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 7 },
  rowLabel: { fontSize: 13, color: c.inkSoft },
  rowValue: { fontSize: 14, color: c.ink, fontWeight: '500', flexShrink: 1, textAlign: 'right', marginLeft: 16 },
  rowValueMono: { fontFamily: mono, fontSize: 13, letterSpacing: 0.3 },

  rail: { paddingLeft: 2 },
  event: { flexDirection: 'row' },
  eventGutter: { width: 22, alignItems: 'center' },
  eventDot: { width: 11, height: 11, borderRadius: 6, borderWidth: 2.5, backgroundColor: c.paper, marginTop: 3 },
  eventLine: { flex: 1, width: 1.5, backgroundColor: c.rule, marginVertical: 3 },
  eventBody: { flex: 1, paddingBottom: 18 },
  eventTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  eventType: { fontSize: 11, fontWeight: '800', letterSpacing: 0.9, textTransform: 'uppercase' },
  eventDate: { fontSize: 11, color: c.inkFaint },
  eventText: { fontSize: 13.5, color: c.ink, lineHeight: 19 },
  eventRemarks: {
    fontSize: 12.5, color: c.inkSoft, marginTop: 5, lineHeight: 17,
    borderLeftWidth: 2, borderLeftColor: c.rule, paddingLeft: 9,
  },
  eventLink: { fontSize: 12, color: c.deep, fontWeight: '700', marginTop: 6 },

  empty: { fontSize: 13, color: c.inkFaint, lineHeight: 19 },
  more: { paddingTop: 4, paddingBottom: 2, alignItems: 'center' },
  moreText: { fontSize: 13, color: c.deep, fontWeight: '700' },

  actions: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 18,
    backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.rule,
  },
  primary: {
    flex: 1, backgroundColor: c.brand, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { color: c.paper, fontSize: 15, fontWeight: '700' },
  secondary: {
    flex: 1, backgroundColor: c.paper, borderRadius: 12, borderWidth: 1.5, borderColor: c.deep,
    paddingVertical: 15, alignItems: 'center', justifyContent: 'center',
  },
  secondaryText: { color: c.deep, fontSize: 15, fontWeight: '700' },
});