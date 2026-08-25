import { useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { verifyAssetOffline } from '../offline/offlineApi';
import * as Location from 'expo-location';
import { ASSET_CONDITIONS } from '../constants/assetConditions';

export default function VerifyModal({ visible, assetCode, onClose, onVerified }) {
  const [condition, setCondition] = useState(null);
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setCondition(null);
    setRemarks('');
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const getCurrentCoords = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return { latitude: null, longitude: null };
      // Verification happens inside branch offices where a precise fix can
      // take a very long time or never arrive. Accept a coarser reading and
      // give up after 10s rather than leaving the officer on a spinner.
      const loc = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
      if (!loc) return { latitude: null, longitude: null };
      return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
    } catch {
      return { latitude: null, longitude: null };
    }
  };

  const handleSubmit = async () => {
    if (!condition) {
      Alert.alert('Select a condition', 'Choose Good, Good with issues, or Faulty.');
      return;
    }
    setSubmitting(true);
    try {
      const coords = await getCurrentCoords();
      const result = await verifyAssetOffline(assetCode, {
        condition,
        remarks: remarks.trim() || null,
        latitude: coords.latitude,
        longitude: coords.longitude,
      });
      reset();
      onVerified(result);
    } catch (err) {
      Alert.alert('Error', err.response?.data?.error || 'Failed to verify asset.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={styles.container}>
        <Text style={styles.title}>Verify Asset</Text>
        <Text style={styles.subtitle}>{assetCode}</Text>

        <Text style={styles.sectionLabel}>Condition</Text>
        {ASSET_CONDITIONS.map((c) => (
          <TouchableOpacity
            key={c}
            style={[styles.option, condition === c && optionColor(c)]}
            onPress={() => setCondition(c)}
          >
            <Text style={condition === c ? styles.optionTextSelected : styles.optionText}>{c}</Text>
          </TouchableOpacity>
        ))}

        <Text style={styles.sectionLabel}>Remarks</Text>
        <TextInput
          style={styles.remarksInput}
          placeholder="Describe the condition, damage, missing parts, etc. (optional)"
          placeholderTextColor="#999"
          value={remarks}
          onChangeText={setRemarks}
          multiline
          numberOfLines={4}
        />

        <Text style={styles.hint}>Your current location will be captured automatically. Works offline — will sync when you're back online.</Text>

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.cancelButton} onPress={handleClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.confirmButton} onPress={handleSubmit} disabled={submitting}>
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.confirmText}>Submit Verification</Text>}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function optionColor(condition) {
  if (condition === 'Good') return { backgroundColor: '#2d7a4f' };
  if (condition === 'Good with issues') return { backgroundColor: '#c98a1d' };
  return { backgroundColor: '#b23a3a' };
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 60 },
  title: { fontSize: 20, fontWeight: 'bold' },
  subtitle: { fontSize: 14, color: '#777', marginBottom: 20 },
  sectionLabel: { fontSize: 14, fontWeight: '600', color: '#777', marginTop: 12, marginBottom: 6 },
  option: {
    padding: 14, borderRadius: 8, backgroundColor: '#f0f0f0', marginBottom: 8,
  },
  optionText: { color: '#333', fontWeight: '500' },
  optionTextSelected: { color: '#fff', fontWeight: '600' },
  remarksInput: {
    borderWidth: 1, borderColor: '#E4E7EC', borderRadius: 10, padding: 12,
    minHeight: 90, textAlignVertical: 'top',
    color: '#14181F', backgroundColor: '#FFFFFF', fontSize: 15,
  },
  hint: { fontSize: 12, color: '#999', marginTop: 10 },
  buttonRow: { flexDirection: 'row', marginTop: 20, gap: 12 },
  cancelButton: {
    flex: 1, padding: 16, borderRadius: 8, backgroundColor: '#eee', alignItems: 'center',
  },
  cancelText: { color: '#333', fontWeight: '600' },
  confirmButton: {
    flex: 1, padding: 16, borderRadius: 8, backgroundColor: '#0A3D4A', alignItems: 'center',
  },
  confirmText: { color: '#fff', fontWeight: '600' },
});