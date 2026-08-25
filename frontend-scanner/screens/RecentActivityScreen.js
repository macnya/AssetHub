import { useState, useEffect } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import api from '../api';

export default function RecentActivityScreen({ onBack }) {
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/dashboard/stats')
      .then((res) => setActivity(res.data.recentActivity || []))
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={onBack} style={styles.backButton}>
        <Text style={styles.backButtonText}>← Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>Recent Activity</Text>

      {loading ? (
        <ActivityIndicator style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={activity}
          keyExtractor={(item, i) => String(i)}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Text style={styles.rowAction}>{item.action}</Text>
              <Text style={styles.rowAsset}>{item.asset_code} — {item.description}</Text>
              <Text style={styles.rowDate}>{new Date(item.timestamp).toLocaleString()}</Text>
            </View>
          )}
          ListEmptyComponent={<Text style={{ textAlign: 'center', marginTop: 30, color: '#999' }}>No recent activity.</Text>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  backButton: { marginBottom: 10 },
  backButtonText: { color: '#0D7C74', fontSize: 16 },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 16 },
  row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee' },
  rowAction: { fontWeight: '600', color: '#1a1a1a' },
  rowAsset: { color: '#555', marginTop: 2 },
  rowDate: { color: '#999', fontSize: 12, marginTop: 2 },
});