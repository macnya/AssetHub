import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { getAssetByCodeOffline } from '../offline/offlineApi';

export default function ScannerScreen({ onScanSuccess, onNotFound, onBack }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleBarcodeScanned = async ({ data }) => {
    if (scanned || loading) return;
    setScanned(true);
    setLoading(true);

    try {
      const { data: assetData, fromCache } = await getAssetByCodeOffline(data);
      if (fromCache) {
        Alert.alert('Offline', 'Showing last saved data for this asset.', [{ text: 'OK' }]);
      }
      onScanSuccess(assetData);
    } catch (err) {
      if (err.response?.status === 404) {
        Alert.alert(
          'Not found',
          `No asset found with code "${data}". Would you like to add it as a new asset?`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => setScanned(false) },
            { text: 'Add New Asset', onPress: () => onNotFound(data) },
          ]
        );
      } else {
        Alert.alert('Error', "This asset has never been loaded on this device, so it can't be shown offline.", [
          { text: 'OK', onPress: () => setScanned(false) },
        ]);
      }
    } finally {
      setLoading(false);
    }
  };

  if (!permission) {
    return <View style={styles.center}><ActivityIndicator /></View>;
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.message}>Camera access is needed to scan asset codes.</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        barcodeScannerSettings={{ barcodeTypes: ['code128'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
      />

      <View style={styles.overlay}>
        <Text style={styles.instruction}>
          {loading ? 'Looking up asset...' : 'Point camera at an asset barcode'}
        </Text>
        {loading && <ActivityIndicator color="#fff" style={{ marginTop: 10 }} />}
      </View>

      <TouchableOpacity style={styles.backButton} onPress={onBack}>
        <Text style={styles.backButtonText}>← Home</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
  message: { textAlign: 'center', marginBottom: 20, fontSize: 16 },
  overlay: {
    position: 'absolute', bottom: 60, left: 0, right: 0,
    alignItems: 'center', padding: 16,
  },
  instruction: {
    color: '#fff', backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 10, borderRadius: 8, fontSize: 16,
  },
  backButton: {
    position: 'absolute', top: 50, right: 20,
    backgroundColor: 'rgba(0,0,0,0.6)', padding: 10, borderRadius: 8,
  },
  backButtonText: { color: '#fff', fontWeight: '600' },
  button: {
    backgroundColor: '#0A3D4A', borderRadius: 8, padding: 16, alignItems: 'center',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});