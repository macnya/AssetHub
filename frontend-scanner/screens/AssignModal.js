import { useState, useEffect, useMemo } from 'react';
import {
  Modal, View, Text, FlatList, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { fetchEmployeesOffline, fetchLocationsOffline, requestCustodyOffline } from '../offline/offlineApi';
import { getCachedEmployees, getCachedLocations } from '../db/localDb';
import * as Location from 'expo-location';
import { c } from '../theme';

const norm = (v) => String(v ?? '').toLowerCase();

export default function AssignModal({ visible, assetId, assetCode, onClose, onAssigned }) {
  const [tab, setTab] = useState('person');          // 'person' | 'place'
  const [employees, setEmployees] = useState([]);
  const [locations, setLocations] = useState([]);
  const [query, setQuery] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [selectedLocation, setSelectedLocation] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // HR 9.3b makes an employee liable for damage through negligence to property
  // entrusted to them. Without the condition at the moment of handover nobody
  // can show whether damage happened on their watch — which protects the
  // employee as much as the organisation. So it is required when equipment goes
  // to a person, and not asked for when an asset is simply parked somewhere.
  const [condition, setCondition] = useState(null);

  useEffect(() => {
    if (!visible) return;

    setQuery('');
    setSelectedEmployee(null);
    setSelectedLocation(null);
    setCondition(null);

    // Cache first. Reading SQLite is instant, so the list is on screen before
    // any request goes out — this used to wait on two round trips of ~1,350
    // rows, which on a sleeping server meant staring at a spinner.
    try {
      setEmployees(getCachedEmployees());
      setLocations(getCachedLocations());
    } catch {
      // No cache yet on this device; the refresh below will fill it.
    }

    let cancelled = false;
    setRefreshing(true);
    Promise.all([fetchEmployeesOffline(), fetchLocationsOffline()])
      .then(([emps, locs]) => {
        if (cancelled) return;
        setEmployees(emps);
        setLocations(locs);
      })
      .catch(() => {
        // Offline is fine — whatever came out of the cache stays on screen.
      })
      .finally(() => !cancelled && setRefreshing(false));

    return () => { cancelled = true; };
  }, [visible]);

  const people = useMemo(() => {
    const q = norm(query).trim();
    if (!q) return employees;
    return employees.filter(
      (e) => norm(e.name).includes(q) || norm(e.branch).includes(q) || norm(e.department).includes(q)
    );
  }, [employees, query]);

  const places = useMemo(() => {
    const q = norm(query).trim();
    if (!q) return locations;
    return locations.filter(
      (l) => norm(l.branch).includes(q) || norm(l.physical_location).includes(q) || norm(l.department).includes(q)
    );
  }, [locations, query]);

  const chosenPerson = employees.find((e) => e.id === selectedEmployee);
  const chosenPlace = locations.find((l) => l.id === selectedLocation);

  async function getCurrentCoords() {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return { latitude: null, longitude: null };
      const loc = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
      if (!loc) return { latitude: null, longitude: null };
      return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
    } catch {
      return { latitude: null, longitude: null };
    }
  }

  const handleConfirm = async () => {
    if (!selectedEmployee && !selectedLocation) {
      Alert.alert('Nothing selected', 'Choose the person holding this asset, the place it lives, or both.');
      return;
    }
    if (selectedEmployee && !condition) {
      Alert.alert(
        'Condition needed',
        'Record what condition the equipment is in before it changes hands. This is what protects both sides if it is damaged later.'
      );
      return;
    }

    setSubmitting(true);
    try {
      const coords = await getCurrentCoords();

      // A request, not an assignment. Nothing moves in the register until an
      // administrator approves it.
      const result = await requestCustodyOffline(assetCode, {
        asset_id: assetId,
        kind: 'assign',
        employee_id: selectedEmployee,
        location_id: selectedLocation,
        condition: selectedEmployee ? condition : null,
        latitude: coords.latitude,
        longitude: coords.longitude,
      });
      onAssigned(result);
    } catch (err) {
      Alert.alert('Could not record that', err.response?.data?.error || 'Try again once you have a signal.');
    } finally {
      setSubmitting(false);
    }
  };

  const list = tab === 'person' ? people : places;
  const total = tab === 'person' ? employees.length : locations.length;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.screen}>
        <View style={s.header}>
          <Text style={s.title}>Assign {assetCode}</Text>
          {refreshing ? <ActivityIndicator size="small" color={c.inkFaint} /> : null}
        </View>

        {(chosenPerson || chosenPlace) && (
          <View style={s.selected}>
            {chosenPerson && (
              <TouchableOpacity style={s.pill} onPress={() => setSelectedEmployee(null)}>
                <Text style={s.pillText}>{chosenPerson.name}</Text>
                <Text style={s.pillX}>×</Text>
              </TouchableOpacity>
            )}
            {chosenPlace && (
              <TouchableOpacity style={s.pill} onPress={() => setSelectedLocation(null)}>
                <Text style={s.pillText}>
                  {chosenPlace.branch}{chosenPlace.physical_location ? ` · ${chosenPlace.physical_location}` : ''}
                </Text>
                <Text style={s.pillX}>×</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={s.tabs}>
          {['person', 'place'].map((t) => (
            <TouchableOpacity
              key={t}
              style={[s.tab, tab === t && s.tabActive]}
              onPress={() => { setTab(t); setQuery(''); }}
            >
              <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                {t === 'person' ? 'Person' : 'Place'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <TextInput
          style={s.search}
          placeholder={tab === 'person' ? 'Search name or branch' : 'Search branch or room'}
          placeholderTextColor={c.inkFaint}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          clearButtonMode="while-editing"
        />

        <Text style={s.count}>
          {query ? `${list.length} of ${total}` : `${total} ${tab === 'person' ? 'people' : 'places'}`}
        </Text>

        <FlatList
          data={list}
          keyExtractor={(item) => `${tab}-${item.id}`}
          style={s.list}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={12}
          ListEmptyComponent={
            <Text style={s.empty}>
              {total === 0
                ? "Nothing saved on this phone yet. Open this once with a signal and it'll work offline afterwards."
                : `No match for "${query}".`}
            </Text>
          }
          renderItem={({ item }) => {
            const isPerson = tab === 'person';
            const id = item.id;
            const chosen = isPerson ? selectedEmployee === id : selectedLocation === id;
            const primary = isPerson
              ? item.name
              : `${item.branch}${item.physical_location ? ` · ${item.physical_location}` : ''}`;
            const secondary = isPerson
              ? [item.branch, item.department].filter(Boolean).join(' · ')
              : item.department;

            return (
              <TouchableOpacity
                style={[s.option, chosen && s.optionChosen]}
                onPress={() =>
                  isPerson
                    ? setSelectedEmployee(chosen ? null : id)
                    : setSelectedLocation(chosen ? null : id)
                }
              >
                <View style={{ flex: 1 }}>
                  <Text style={[s.optionText, chosen && s.optionTextChosen]}>{primary}</Text>
                  {secondary ? (
                    <Text style={[s.optionMeta, chosen && { color: 'rgba(255,255,255,0.75)' }]}>{secondary}</Text>
                  ) : null}
                </View>
                {chosen ? <Text style={s.tick}>✓</Text> : null}
              </TouchableOpacity>
            );
          }}
        />

        {/* Only when equipment goes to a person. An asset parked on a shelf
            has no custodian to hold responsible, so asking would be noise. */}
        {selectedEmployee ? (
          <View style={s.conditionBlock}>
            <Text style={s.conditionLabel}>Condition at handover</Text>
            <View style={s.conditionRow}>
              {['Good', 'Good with issues', 'Faulty'].map((opt) => (
                <TouchableOpacity
                  key={opt}
                  style={[s.conditionChip, condition === opt && s.conditionChipOn]}
                  onPress={() => setCondition(opt)}
                >
                  <Text style={[s.conditionText, condition === opt && s.conditionTextOn]}>{opt}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        <View style={s.actions}>
          <TouchableOpacity style={s.cancel} onPress={onClose}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.confirm} onPress={handleConfirm} disabled={submitting}>
            {submitting
              ? <ActivityIndicator color={c.paper} />
              : <Text style={s.confirmText}>Request</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.paper, paddingTop: 50 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingBottom: 12,
  },
  title: { fontSize: 20, fontWeight: '700', color: c.ink },

  selected: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 20, paddingBottom: 12 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: c.deep, borderRadius: 20, paddingVertical: 7, paddingHorizontal: 13,
  },
  pillText: { color: c.paper, fontSize: 13, fontWeight: '600' },
  pillX: { color: 'rgba(255,255,255,0.7)', fontSize: 16, lineHeight: 16 },

  tabs: {
    flexDirection: 'row', marginHorizontal: 20, marginBottom: 12,
    backgroundColor: c.surface, borderRadius: 10, padding: 3,
  },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  tabActive: { backgroundColor: c.paper, borderWidth: 1, borderColor: c.rule },
  tabText: { fontSize: 14, fontWeight: '600', color: c.inkSoft },
  tabTextActive: { color: c.ink },

  search: {
    marginHorizontal: 20, borderWidth: 1, borderColor: c.rule, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    color: c.ink, backgroundColor: c.paper,
  },
  count: {
    fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase', fontWeight: '700',
    color: c.inkFaint, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6,
  },

  list: { flex: 1, paddingHorizontal: 20 },
  option: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 10,
    backgroundColor: c.surface, marginBottom: 7,
  },
  optionChosen: { backgroundColor: c.deep },
  optionText: { fontSize: 15, color: c.ink, fontWeight: '500' },
  optionTextChosen: { color: c.paper, fontWeight: '700' },
  optionMeta: { fontSize: 12, color: c.inkFaint, marginTop: 2 },
  tick: { color: c.paper, fontSize: 17, fontWeight: '700', marginLeft: 10 },
  empty: { fontSize: 13.5, color: c.inkFaint, lineHeight: 20, paddingVertical: 20 },

  conditionBlock: {
    paddingHorizontal: 20, paddingTop: 14, paddingBottom: 2,
    borderTopWidth: 1, borderTopColor: c.rule,
  },
  conditionLabel: {
    fontSize: 11, letterSpacing: 1.1, textTransform: 'uppercase',
    fontWeight: '700', color: c.inkFaint, marginBottom: 9,
  },
  conditionRow: { flexDirection: 'row', gap: 8 },
  conditionChip: {
    flex: 1, paddingVertical: 11, borderRadius: 10,
    borderWidth: 1.5, borderColor: c.rule, alignItems: 'center', backgroundColor: c.paper,
  },
  conditionChipOn: { borderColor: c.brand, backgroundColor: '#E7F2F1' },
  conditionText: { fontSize: 12.5, fontWeight: '600', color: c.inkSoft, textAlign: 'center' },
  conditionTextOn: { color: c.brand },

  actions: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20,
    borderTopWidth: 1, borderTopColor: c.rule,
  },
  cancel: {
    flex: 1, paddingVertical: 15, borderRadius: 12,
    borderWidth: 1.5, borderColor: c.rule, alignItems: 'center',
  },
  cancelText: { color: c.inkSoft, fontSize: 15, fontWeight: '600' },
  confirm: {
    flex: 1, paddingVertical: 15, borderRadius: 12,
    backgroundColor: c.brand, alignItems: 'center', justifyContent: 'center',
  },
  confirmText: { color: c.paper, fontSize: 15, fontWeight: '700' },
});