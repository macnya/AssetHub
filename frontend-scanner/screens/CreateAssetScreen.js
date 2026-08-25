import { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { fetchCategories, createAsset } from '../api';
import { ASSET_CONDITIONS, DEFAULT_CONDITION } from '../constants/assetConditions';
import { c, mono, conditionColor } from '../theme';

export default function CreateAssetScreen({ scannedCode, onCreated, onCancel }) {
  const [categories, setCategories] = useState([]);
  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [supplier, setSupplier] = useState('');
  const [condition, setCondition] = useState(DEFAULT_CONDITION);
  const [loading, setLoading] = useState(false);
  const [loadingCategories, setLoadingCategories] = useState(true);

  useEffect(() => {
    fetchCategories()
      .then((cats) => {
        setCategories(cats);
        if (cats.length > 0) setCategoryId(String(cats[0].id));
      })
      .catch(() => Alert.alert('Could not load categories', 'Check your connection and try again.'))
      .finally(() => setLoadingCategories(false));
  }, []);

  const handleSubmit = async () => {
    if (!description.trim()) {
      Alert.alert('Description needed', 'Enter what this asset is, for example "HP EliteBook 840".');
      return;
    }
    setLoading(true);
    try {
      const asset = await createAsset({
        asset_code: scannedCode,
        description: description.trim(),
        asset_category_id: categoryId ? parseInt(categoryId, 10) : null,
        serial_number: serialNumber.trim() || null,
        supplier: supplier.trim() || null,
        condition,
      });
      onCreated(asset);
    } catch (err) {
      Alert.alert('Could not create this asset', err.response?.data?.error || 'Try again once you have a signal.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={s.screen}>
      <View style={s.header}>
        <TouchableOpacity onPress={onCancel} style={s.backButton} activeOpacity={0.6}>
          <Text style={s.backChevron}>‹</Text>
          <Text style={s.backLabel}>Back</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>New asset</Text>
      </View>

      <ScrollView style={s.scroll} contentContainerStyle={s.scrollInner} keyboardShouldPersistTaps="handled">
        <View style={s.codeCard}>
          <Text style={s.eyebrow}>Scanned code</Text>
          <Text style={s.code}>{scannedCode}</Text>
          <Text style={s.codeNote}>This barcode isn't in the register yet. Fill in what you can see.</Text>
        </View>

        <Field label="What is it?" required>
          <TextInput
            style={s.input}
            placeholder="e.g. HP EliteBook 840 laptop"
            placeholderTextColor={c.inkFaint}
            value={description}
            onChangeText={setDescription}
          />
        </Field>

        <Field label="Category">
          {loadingCategories ? (
            <View style={s.pickerBox}><ActivityIndicator style={{ margin: 12 }} /></View>
          ) : (
            <View style={s.pickerBox}>
              <Picker
                selectedValue={categoryId}
                onValueChange={setCategoryId}
                dropdownIconColor={c.inkSoft}
                style={s.picker}
              >
                {categories.map((cat) => (
                  <Picker.Item key={cat.id} label={cat.name} value={String(cat.id)} color={c.ink} />
                ))}
              </Picker>
            </View>
          )}
        </Field>

        <Field label="Serial number" hint="Printed on the device, often under a barcode">
          <TextInput
            style={[s.input, s.inputMono]}
            placeholder="Leave blank if none"
            placeholderTextColor={c.inkFaint}
            value={serialNumber}
            onChangeText={setSerialNumber}
            autoCapitalize="characters"
          />
        </Field>

        <Field label="Supplier">
          <TextInput
            style={s.input}
            placeholder="Who it was bought from"
            placeholderTextColor={c.inkFaint}
            value={supplier}
            onChangeText={setSupplier}
          />
        </Field>

        <Field label="Condition" hint="What you can see right now">
          <View style={s.conditionRow}>
            {ASSET_CONDITIONS.map((option) => {
              const selected = condition === option;
              return (
                <TouchableOpacity
                  key={option}
                  onPress={() => setCondition(option)}
                  style={[
                    s.conditionChip,
                    selected && { borderColor: conditionColor(option), backgroundColor: conditionColor(option) },
                  ]}
                >
                  <Text style={[s.conditionText, selected && { color: c.paper }]}>{option}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Field>
      </ScrollView>

      <View style={s.actions}>
        <TouchableOpacity style={s.primary} onPress={handleSubmit} disabled={loading}>
          {loading ? <ActivityIndicator color={c.paper} /> : <Text style={s.primaryText}>Create asset</Text>}
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Field({ label, hint, required, children }) {
  return (
    <View style={s.field}>
      <Text style={s.label}>
        {label}
        {required ? <Text style={{ color: c.brand }}> *</Text> : null}
      </Text>
      {children}
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
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

  codeCard: {
    backgroundColor: c.paper, borderRadius: 14, borderWidth: 1, borderColor: c.rule,
    paddingVertical: 18, paddingHorizontal: 18, marginBottom: 18, alignItems: 'center',
  },
  eyebrow: {
    fontSize: 10, letterSpacing: 1.6, textTransform: 'uppercase',
    color: c.inkFaint, fontWeight: '700', marginBottom: 6,
  },
  code: { fontFamily: mono, fontSize: 26, letterSpacing: 1.4, color: c.ink, fontWeight: '700' },
  codeNote: { fontSize: 12.5, color: c.inkSoft, textAlign: 'center', marginTop: 10, lineHeight: 18 },

  field: { marginBottom: 18 },
  label: { fontSize: 13, fontWeight: '600', color: c.ink, marginBottom: 7 },
  hint: { fontSize: 11.5, color: c.inkFaint, marginTop: 6 },

  // color and backgroundColor are explicit on purpose: Android tints input text
  // for the system theme, and against a hardcoded white card that made typed
  // characters invisible.
  input: {
    borderWidth: 1, borderColor: c.rule, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 13, fontSize: 15,
    color: c.ink, backgroundColor: c.paper,
  },
  inputMono: { fontFamily: mono, letterSpacing: 0.4 },

  pickerBox: {
    borderWidth: 1, borderColor: c.rule, borderRadius: 10,
    backgroundColor: c.paper, overflow: 'hidden',
  },
  picker: { color: c.ink },

  conditionRow: { flexDirection: 'row', gap: 8 },
  conditionChip: {
    flex: 1, borderWidth: 1.5, borderColor: c.rule, borderRadius: 10,
    paddingVertical: 11, paddingHorizontal: 6, alignItems: 'center', backgroundColor: c.paper,
  },
  conditionText: { fontSize: 12.5, fontWeight: '600', color: c.inkSoft, textAlign: 'center' },

  actions: {
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 18,
    backgroundColor: c.paper, borderTopWidth: 1, borderTopColor: c.rule,
  },
  primary: {
    backgroundColor: c.brand, borderRadius: 12,
    paddingVertical: 15, alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { color: c.paper, fontSize: 15, fontWeight: '700' },
});