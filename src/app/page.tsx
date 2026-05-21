'use client';

import React, { useState, useRef } from 'react';
import useSWR from 'swr';
import { 
  Plus, 
  X, 
  Info, 
  CheckCircle2, 
  AlertCircle, 
  MapPin, 
  Loader2, 
  Image as ImageIcon,
  Compass,
  LayoutGrid,
  ExternalLink,
  Download,
  Lock,
  Unlock,
  Trash2,
  Pencil,
  Check,
  Users,
  Trophy,
  BarChart2
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip as RechartsTooltip, 
  Legend 
} from 'recharts';
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { 
  Dialog, 
  DialogContent, 
  DialogDescription, 
  DialogHeader, 
  DialogTitle, 
  DialogFooter 
} from "@/components/ui/dialog";
import colorNames from '@/lib/colors.json';

const fetcher = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error || 'Erreur de chargement des données.');
  }
  return res.json();
};

function getWplaceUrl(chunkX: number, chunkY: number, offsetX: number, offsetY: number) {
  const n = 2048000;
  const absX = 1000 * chunkX + offsetX;
  const absY = 1000 * chunkY + offsetY;
  const lng = 360 * (absX / n) - 180;
  const t_val = absY / n;
  const lat = (360 * (Math.atan(Math.exp(Math.PI - 2 * Math.PI * t_val)) - Math.PI / 4)) / Math.PI;
  return `https://wplace.live/?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}&zoom=12`;
}

function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const handleDownload = async (url: string, filename: string) => {
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  } catch (err) {
    console.error('Erreur lors du téléchargement de l\'image:', err);
  }
};

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const activePayload = payload.filter((p: any) => p.value > 0);
    if (activePayload.length === 0) return null;
    
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-[11px] shadow-xl min-w-[140px]">
        <p className="font-bold text-slate-200 mb-1.5 border-b border-slate-900 pb-1">{label}</p>
        <div className="space-y-1">
          {activePayload.map((pld: any) => (
            <div key={pld.name} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: pld.fill || pld.color }} />
                <span className="text-slate-400 font-medium">{pld.name}</span>
              </div>
              <span className="font-mono font-bold text-slate-200">{pld.value} px</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return null;
};

export default function Dashboard() {
  // Details Modal state (déclaré en premier pour être disponible dans le hook useSWR)
  const [detailDrawing, setDetailDrawing] = useState<any | null>(null);
  
  const { data: drawings, error, mutate } = useSWR('/api/drawings', fetcher, { 
    refreshInterval: 60000 
  });
  
  // États pour le minuteur circulaire et les logs de changements
  const [secsLeft, setSecsLeft] = useState(300);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<string | null>(null);
  const prevDrawingsRef = useRef<any[] | null>(null);

  const getColorName = (hex: string) => {
    const upperHex = hex.toUpperCase();
    return (colorNames as Record<string, string>)[upperHex] || hex;
  };

  // Hook de détection et log en console des modifications de progression
  React.useEffect(() => {
    if (!drawings || !Array.isArray(drawings)) return;
    
    if (prevDrawingsRef.current) {
      drawings.forEach((drawing: any) => {
        const prevDrawing = prevDrawingsRef.current?.find((d: any) => d.id === drawing.id);
        if (prevDrawing) {
          const prevProgress = prevDrawing.progress?.[0];
          const currentProgress = drawing.progress?.[0];
          
          const prevCorrect = prevProgress?.correctPixels || 0;
          const currentCorrect = currentProgress?.correctPixels || 0;
          
          const prevWrong = prevProgress?.wrongPixels || 0;
          const currentWrong = currentProgress?.wrongPixels || 0;
          
          if (prevCorrect !== currentCorrect || prevWrong !== currentWrong) {
            const diffCorrect = currentCorrect - prevCorrect;
            const diffWrong = currentWrong - prevWrong;
            
            console.log(
              `%c[Wplace Tracker] Modification détectée pour "${drawing.name}" : %cCorrect: ${prevCorrect} → ${currentCorrect} (${diffCorrect >= 0 ? '+' : ''}${diffCorrect}) | Erreurs: ${prevWrong} → ${currentWrong} (${diffWrong >= 0 ? '+' : ''}${diffWrong})`,
              'color: #3b82f6; font-weight: bold;',
              'color: #10b981; font-weight: bold;'
            );
          }
        }
      });
    }
    
    prevDrawingsRef.current = drawings;
  }, [drawings]);

  // Hook de compte à rebours circulaire toutes les 5 minutes avec déclenchement automatique
  React.useEffect(() => {
    if (isSyncing) return;

    const timer = setInterval(() => {
      setSecsLeft((prev) => {
        if (prev <= 1) {
          const runSequentialSync = async () => {
            setIsSyncing(true);
            const drawingsToSync = drawings && Array.isArray(drawings) ? drawings : [];
            
            if (drawingsToSync.length === 0) {
              setSyncProgress("Aucun dessin à vérifier");
              await new Promise(r => setTimeout(r, 1000));
              setIsSyncing(false);
              setSyncProgress(null);
              return;
            }

            console.log("%c[Wplace Tracker] 🔄 Déclenchement automatique de la vérification séquentielle...", "color: #eab308; font-weight: bold;");
            const startTime = Date.now();
            
            for (let i = 0; i < drawingsToSync.length; i++) {
              const drawing = drawingsToSync[i];
              setSyncProgress(`Vérification : ${drawing.name} (${i + 1}/${drawingsToSync.length})`);
              
              try {
                const res = await fetch(`/api/cron/sync?drawingId=${drawing.id}`);
                const data = await res.json();
                console.log(`[Wplace Tracker] Synchro dessin "${drawing.name}" terminée :`, data);
                await mutate();
              } catch (err) {
                console.error(`[Wplace Tracker] Erreur synchro dessin "${drawing.name}" :`, err);
              }
            } 
            
            const totalDuration = Date.now() - startTime;
            console.log(`%c[Wplace Tracker] ✅ Vérification complète terminée en ${totalDuration}ms !`, "color: #10b981; font-weight: bold;");
            setSyncProgress(null);
            setIsSyncing(false);
          };

          runSequentialSync();
          return 300;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [isSyncing, drawings, mutate]);

  // Modal & Form states
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [chunkX, setChunkX] = useState('');
  const [chunkY, setChunkY] = useState('');
  const [offsetX, setOffsetX] = useState('');
  const [offsetY, setOffsetY] = useState('');
  const [wplaceUrl, setWplaceUrl] = useState('');
  const [pseudo, setPseudo] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  
  const [detailTab, setDetailTab] = useState<'colors' | 'contributors'>('colors');
  const [isTriggeringAnalysis, setIsTriggeringAnalysis] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [expandedContributor, setExpandedContributor] = useState<string | null>(null);
  const [chartMousePos, setChartMousePos] = useState<{ x: number; y: number } | null>(null);

  const openDetailModal = (drawing: any) => {
    setDetailDrawing(drawing);
    setDetailTab('colors');
    setShowChart(false);
    setExpandedContributor(null);
    setChartMousePos(null);
  };
  
  // Submission & Status states
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Admin-related states
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPasswordModalOpen, setIsPasswordModalOpen] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Edit drawing states
  const [editDrawing, setEditDrawing] = useState<any | null>(null);
  const [editName, setEditName] = useState('');
  const [editChunkX, setEditChunkX] = useState('');
  const [editChunkY, setEditChunkY] = useState('');
  const [editOffsetX, setEditOffsetX] = useState('');
  const [editOffsetY, setEditOffsetY] = useState('');
  const [editWplaceUrl, setEditWplaceUrl] = useState('');
  const [editPseudo, setEditPseudo] = useState('');
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete drawing states
  const [deleteDrawing, setDeleteDrawing] = useState<any | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleTriggerAnalysis = async (drawingId: number) => {
    if (!isAdmin) {
      alert("Accès refusé : Le mode administrateur est requis.");
      return;
    }
    setIsTriggeringAnalysis(true);
    try {
      const response = await fetch(`/api/drawings/${drawingId}/analyze`, {
        method: 'POST',
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Erreur lors du lancement de l\'analyse.');
      }
      // Mutate drawings immediately to fetch the updated state
      await mutate();
    } catch (err: any) {
      alert(err.message || 'Une erreur est survenue.');
    } finally {
      setIsTriggeringAnalysis(false);
    }
  };

  const handleValidateDrawing = async (drawingId: number) => {
    try {
      const response = await fetch(`/api/drawings/${drawingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isValidated: true })
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la validation.');
      }

      await mutate();
    } catch (err: any) {
      alert(err.message || 'Une erreur est survenue.');
    }
  };

  // Check authentication status on mount
  React.useEffect(() => {
    const checkAdminStatus = async () => {
      try {
        const response = await fetch('/api/admin/check');
        const data = await response.json();
        setIsAdmin(data.isAdmin);
      } catch (err) {
        console.error('Erreur lors de la vérification de session admin:', err);
        setIsAdmin(false);
      }
    };
    checkAdminStatus();
  }, []);

  const handleAdminLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Mot de passe incorrect.');
      }

      setIsAdmin(true);
      setIsPasswordModalOpen(false);
      setAdminPassword('');
    } catch (err: any) {
      setPasswordError(err.message || 'Une erreur est survenue.');
    }
  };

  const handleAdminLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
    } catch (err) {
      console.error('Erreur lors de la déconnexion:', err);
    } finally {
      setIsAdmin(false);
    }
  };

  const openEditModal = (drawing: any) => {
    setEditDrawing(drawing);
    setEditName(drawing.name);
    setEditChunkX(drawing.chunkX.toString());
    setEditChunkY(drawing.chunkY.toString());
    setEditOffsetX(drawing.offsetX.toString());
    setEditOffsetY(drawing.offsetY.toString());
    setEditWplaceUrl(drawing.wplaceUrl || '');
    setEditPseudo(drawing.pseudo || '');
    setEditError(null);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEditError(null);
    if (!editName.trim()) return setEditError('Veuillez spécifier un nom.');
    if (!editPseudo.trim()) return setEditError('Veuillez spécifier un pseudo.');
    if (editChunkX === '' || editChunkY === '' || editOffsetX === '' || editOffsetY === '') {
      return setEditError('Tous les champs sont obligatoires.');
    }

    setIsSavingEdit(true);
    try {
      const response = await fetch(`/api/drawings/${editDrawing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName,
          chunkX: parseInt(editChunkX),
          chunkY: parseInt(editChunkY),
          offsetX: parseInt(editOffsetX),
          offsetY: parseInt(editOffsetY),
          wplaceUrl: editWplaceUrl || null,
          pseudo: editPseudo,
        })
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la mise à jour.');
      }

      await mutate();
      setEditDrawing(null);
    } catch (err: any) {
      setEditError(err.message || 'Une erreur est survenue.');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteDrawing) return;
    setIsDeleting(true);
    try {
      const response = await fetch(`/api/drawings/${deleteDrawing.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Erreur lors de la suppression.');
      }

      await mutate();
      setDeleteDrawing(null);
    } catch (err: any) {
      alert(err.message || 'Une erreur est survenue.');
    } finally {
      setIsDeleting(false);
    }
  };

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-6 text-center">
        <div className="rounded-2xl border border-red-500/20 bg-red-500/10 p-6 max-w-md shadow-2xl">
          <AlertCircle className="mx-auto h-12 w-12 text-red-500 mb-4" />
          <h2 className="text-xl font-bold text-slate-100 mb-2">Erreur de chargement</h2>
          <p className="text-sm text-slate-400">
            Impossible de se connecter à l'API. Veuillez vérifier que le serveur est démarré.
          </p>
        </div>
      </div>
    );
  }

  if (!drawings) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 p-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-10 w-10 animate-spin text-teal-400" />
          <p className="text-sm font-medium text-slate-400 animate-pulse">
            Chargement du tableau de bord...
          </p>
        </div>
      </div>
    );
  }

  // File picker handler
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setImageFile(file);
      const reader = new FileReader();
      reader.onloadend = () => {
        setImagePreview(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/')) {
        setImageFile(file);
        const reader = new FileReader();
        reader.onloadend = () => {
          setImagePreview(reader.result as string);
        };
        reader.readAsDataURL(file);
      } else {
        setFormError('Veuillez sélectionner un fichier image valide (PNG ou JPG).');
      }
    }
  };

  const removeSelectedImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setImageFile(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const resetForm = () => {
    setName('');
    setChunkX('');
    setChunkY('');
    setOffsetX('');
    setOffsetY('');
    setWplaceUrl('');
    setPseudo('');
    setImageFile(null);
    setImagePreview(null);
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!name.trim()) return setFormError('Veuillez spécifier un nom de dessin.');
    if (!pseudo.trim()) return setFormError('Veuillez spécifier votre pseudo.');
    if (chunkX === '') return setFormError('Veuillez spécifier une coordonnée Chunk X.');
    if (chunkY === '') return setFormError('Veuillez spécifier une coordonnée Chunk Y.');
    if (offsetX === '') return setFormError('Veuillez spécifier une coordonnée Offset X.');
    if (offsetY === '') return setFormError('Veuillez spécifier une coordonnée Offset Y.');
    if (!imageFile) return setFormError('Veuillez importer une image.');

    setIsSubmitting(true);

    const formData = new FormData();
    formData.append('name', name);
    formData.append('chunkX', chunkX);
    formData.append('chunkY', chunkY);
    formData.append('offsetX', offsetX);
    formData.append('offsetY', offsetY);
    formData.append('wplaceUrl', wplaceUrl);
    formData.append('pseudo', pseudo);
    formData.append('image', imageFile);

    try {
      const response = await fetch('/api/drawings', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Erreur lors de la création du dessin.');
      }

      // Success
      await mutate();
      setIsModalOpen(false);
      resetForm();
    } catch (err: any) {
      setFormError(err.message || 'Une erreur inattendue est survenue.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Find updated drawing to show current real-time details
  const activeDetailDrawing = (detailDrawing && Array.isArray(drawings))
    ? drawings.find((d: any) => d.id === detailDrawing.id) || detailDrawing 
    : null;

  // Calcul du jeu de données pour le graphique à barres empilées de Recharts
  const allUniqueColors = new Set<string>();
  const chartData = (activeDetailDrawing?.contributors || []).map((contrib: any) => {
    const rawColors = contrib.colors;
    const parsedColors = typeof rawColors === 'object' && rawColors !== null ? (rawColors as Record<string, number>) : {};
    
    const dataEntry: Record<string, any> = {
      name: contrib.username,
    };
    
    Object.entries(parsedColors).forEach(([color, count]) => {
      allUniqueColors.add(color);
      dataEntry[color] = count;
    });
    
    return dataEntry;
  });

  const sortedColorStats = activeDetailDrawing?.colorStats
    ? [...activeDetailDrawing.colorStats].sort((a: any, b: any) => {
        const remainingA = Math.max(0, a.pixelCount - (a.correctCount || 0));
        const remainingB = Math.max(0, b.pixelCount - (b.correctCount || 0));
        return remainingB - remainingA; // Descending order
      })
    : [];

  const displayedDrawings = Array.isArray(drawings)
    ? drawings.filter((d: any) => d.isValidated || isAdmin)
    : [];

  return (
    <div className="relative min-h-screen bg-slate-950 text-slate-100 overflow-x-hidden">
      
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 relative z-10">
        
        {/* Header Section */}
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between border-b border-slate-900 pb-6 mb-8 gap-4">
          <div>
            <div className="flex items-center gap-3">
              <div className="bg-blue-600 p-2.5 rounded-xl shadow-md">
                <Compass className="h-5 w-5 text-white" />
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                Wplace.live Tracker
              </h1>
            </div>
            <p className="mt-2 text-sm text-slate-400">
              Suivi d'avancement et colorimétrie des dessins en temps réel
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-3.5 w-full sm:w-auto">
            {/* Minuteur circulaire de compte à rebours */}
            <div className="flex items-center gap-3 bg-slate-900/60 border border-slate-800/80 px-3.5 py-2 rounded-full shadow-lg backdrop-blur-md w-full sm:w-auto justify-center sm:justify-start" title="Temps restant avant la prochaine synchronisation automatique des pixels par le serveur">
              <div className="relative flex items-center justify-center h-6 w-6 flex-shrink-0">
                <svg className="absolute w-6 h-6 transform -rotate-90">
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    className="stroke-slate-800"
                    strokeWidth="2.5"
                    fill="transparent"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    className={`stroke-teal-500 transition-all ${isSyncing ? 'animate-pulse' : 'duration-1000 ease-linear'}`}
                    strokeWidth="2.5"
                    fill="transparent"
                    strokeDasharray={56.54}
                    strokeDashoffset={isSyncing ? 0 : 56.54 * (secsLeft / 300)}
                  />
                </svg>
                <span className="text-[9px] font-bold font-mono text-slate-400">
                  {isSyncing ? "..." : `${Math.floor(secsLeft / 60)}m`}
                </span>
              </div>
              <div className="flex flex-col text-left">
                <span className="text-[9px] font-bold text-slate-500 font-mono tracking-wider uppercase leading-none">
                  {isSyncing ? "Vérification" : "Prochaine synchro"}
                </span>
                <span className="text-[11px] font-bold text-teal-400 font-mono mt-0.5 leading-none">
                  {isSyncing ? (syncProgress || "En cours...") : `dans ${Math.floor(secsLeft / 60)}m ${(secsLeft % 60).toString().padStart(2, '0')}s`}
                </span>
              </div>
            </div>

            {isAdmin ? (
              <Button 
                variant="outline" 
                onClick={handleAdminLogout}
                className="w-full sm:w-auto border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Unlock className="mr-2 h-4 w-4" />
                Quitter Admin
              </Button>
            ) : (
              <Button 
                variant="outline" 
                onClick={() => setIsPasswordModalOpen(true)}
                className="w-full sm:w-auto border-slate-800 text-slate-400 hover:bg-slate-900 hover:text-slate-200"
              >
                <Lock className="mr-2 h-4 w-4" />
                Mode Admin
              </Button>
            )}
            <Button 
              variant="premium" 
              onClick={() => setIsModalOpen(true)}
              className="w-full sm:w-auto"
            >
              <Plus className="mr-2 h-5 w-5" />
              Nouveau Dessin
            </Button>
          </div>
        </header>

        {/* Drawings Grid */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {displayedDrawings.map((drawing: any) => {
            const latestProgress = drawing.progress?.[0];
            const correct = latestProgress?.correctPixels || 0;
            const wrong = latestProgress?.wrongPixels || 0;
            const percent = ((correct / drawing.totalPixels) * 100).toFixed(2);
            const remaining = drawing.totalPixels - correct;

            return (
              <Card key={drawing.id} className="flex flex-col h-full overflow-hidden border-slate-900">
                {isAdmin && (
                  <div className="flex items-center justify-between px-6 py-2.5 bg-slate-950 border-b border-slate-900/60 text-xs">
                    {drawing.isValidated ? (
                      <span className="font-semibold text-emerald-400 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider">
                        <Unlock className="h-3 w-3" /> Admin Mode
                      </span>
                    ) : (
                      <span className="font-semibold text-amber-500 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider animate-pulse" title="En attente de validation par un admin">
                        <AlertCircle className="h-3.5 w-3.5 text-amber-500" /> En attente
                      </span>
                    )}
                    <div className="flex items-center gap-2.5">
                      {!drawing.isValidated && (
                        <button 
                          onClick={() => handleValidateDrawing(drawing.id)}
                          className="text-emerald-400 hover:text-emerald-300 hover:scale-105 active:scale-95 transition-all p-1 flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-2 py-0.5 font-bold font-mono text-[9px] uppercase tracking-wider"
                          title="Valider et rendre visible ce dessin"
                        >
                          <Check className="h-3 w-3" /> Valider
                        </button>
                      )}
                      <button 
                        onClick={() => openEditModal(drawing)}
                        className="text-slate-400 hover:text-blue-400 transition-colors p-1"
                        title="Modifier le dessin"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button 
                        onClick={() => setDeleteDrawing(drawing)}
                        className="text-slate-400 hover:text-red-400 transition-colors p-1"
                        title="Supprimer le dessin"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-4">
                  <div className="space-y-1 pr-4">
                    <CardTitle className="text-xl font-bold truncate tracking-tight text-slate-200">
                      {drawing.name}
                    </CardTitle>
                    <CardDescription className="flex flex-col gap-1.5 mt-1 pr-2">
                      <span className="flex items-center text-slate-400 gap-1.5 font-mono text-[11px]">
                        <MapPin className="h-3.5 w-3.5 text-teal-400" />
                        Chunk [{drawing.chunkX},{drawing.chunkY}] • Offset [{drawing.offsetX},{drawing.offsetY}]
                      </span>
                      <span className="text-[11px] text-slate-500 font-medium">
                        Créé par : <strong className="text-slate-300">{drawing.pseudo || 'Anonyme'}</strong>
                      </span>
                      {drawing.startedAt ? (
                        <span className="text-[11px] text-slate-500 font-mono leading-none">
                          {drawing.completedAt ? (
                            <span>
                              ⏳ Du {formatDate(drawing.startedAt)} au {formatDate(drawing.completedAt)}
                            </span>
                          ) : (
                            <span>
                              ⏳ Débuté le {formatDate(drawing.startedAt)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-[11px] text-slate-500 font-mono italic leading-none">
                          ⏳ Non commencé
                        </span>
                      )}
                      <a 
                        href={drawing.wplaceUrl || getWplaceUrl(drawing.chunkX, drawing.chunkY, drawing.offsetX, drawing.offsetY)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-400 hover:text-blue-300 hover:underline transition-colors mt-0.5"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Ouvrir sur wplace.live
                      </a>
                    </CardDescription>
                  </div>
                  {drawing.imageUrl && (
                    <div className="relative group overflow-hidden rounded-xl border border-slate-800 bg-slate-950 p-1 flex-shrink-0">
                      <img 
                        src={drawing.imageUrl} 
                        alt={drawing.name} 
                        className="h-14 w-14 object-contain rounded-lg transition-transform duration-300 group-hover:scale-110" 
                      />
                    </div>
                  )}
                </CardHeader>

                <CardContent className="flex-1 flex flex-col justify-end space-y-5">
                  {/* Progress Indicator */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-xs font-semibold uppercase tracking-wider text-blue-400">Progression</span>
                      <span className="font-bold text-slate-100 font-mono">{percent}%</span>
                    </div>
                    <Progress value={parseFloat(percent)} className="h-3" />
                  </div>

                  {/* Core stats block */}
                  <div className="grid grid-cols-3 gap-2.5 text-center">
                    <div className="rounded-xl border border-slate-900 bg-slate-950/40 p-2.5 shadow-inner">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Corrects</div>
                      <div className="text-base font-bold font-mono text-emerald-400 flex items-center justify-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        {correct}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-900 bg-slate-950/40 p-2.5 shadow-inner">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Manquants</div>
                      <div className="text-base font-bold font-mono text-slate-200">
                        {remaining}
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-900 bg-slate-950/40 p-2.5 shadow-inner">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Erreurs</div>
                      <div className="text-base font-bold font-mono text-red-500">
                        {wrong}
                      </div>
                    </div>
                  </div>
                </CardContent>

                <CardFooter className="pt-0 pb-6 px-6 flex gap-2">
                  <Button 
                    variant="secondary" 
                    onClick={() => openDetailModal(drawing)}
                    className="flex-1 flex items-center justify-center gap-2 font-semibold"
                  >
                    <Info className="h-4 w-4" />
                    Détails & Couleurs
                  </Button>
                  {drawing.imageUrl && (
                    <Button
                      variant="outline"
                      size="icon"
                      title="Télécharger l'image modèle"
                      onClick={() => handleDownload(drawing.imageUrl, `${drawing.name.toLowerCase().replace(/\s+/g, '_')}_template.png`)}
                      className="flex-shrink-0"
                    >
                      <Download className="h-4 w-4 text-slate-400 hover:text-slate-200" />
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}

          {displayedDrawings.length === 0 && (
            <div className="col-span-full border-2 border-dashed border-slate-800 rounded-3xl p-12 text-center bg-slate-900/10 backdrop-blur-sm">
              <LayoutGrid className="mx-auto h-12 w-12 text-slate-500 mb-4" />
              <h3 className="text-lg font-semibold text-slate-300">Aucun dessin pour le moment</h3>
              <p className="text-sm text-slate-500 mt-2 max-w-sm mx-auto">
                Ajoutez un premier modèle à suivre en cliquant sur le bouton "Nouveau Dessin" ci-dessus.
              </p>
            </div>
          )}
        </div>

        {/* Form Modal (Add New Drawing) */}
        <Dialog open={isModalOpen} onOpenChange={(open) => { if (!open && !isSubmitting) { setIsModalOpen(false); resetForm(); } }}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-slate-100">
                Ajouter un nouveau dessin
              </DialogTitle>
              <DialogDescription className="text-slate-400 text-xs">
                Spécifiez l'emplacement du modèle sur wplace.live et chargez son template image.
              </DialogDescription>
            </DialogHeader>

            {formError && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Nom */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Nom du dessin</label>
                <input 
                  type="text"
                  placeholder="ex: Coeur Rouge, Logo Antigravity"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  disabled={isSubmitting}
                  required
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50"
                />
              </div>

              {/* Pseudo */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Pseudo du créateur</label>
                <input 
                  type="text"
                  placeholder="ex: Alex, AntigravityFan"
                  value={pseudo}
                  onChange={e => setPseudo(e.target.value)}
                  disabled={isSubmitting}
                  required
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50"
                />
              </div>

              {/* Chunks */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Chunk X</label>
                  <input 
                    type="number"
                    placeholder="ex: 1061"
                    value={chunkX}
                    onChange={e => setChunkX(e.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Chunk Y</label>
                  <input 
                    type="number"
                    placeholder="ex: 367"
                    value={chunkY}
                    onChange={e => setChunkY(e.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>

              {/* Offsets */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Offset X</label>
                  <input 
                    type="number"
                    placeholder="ex: 230"
                    value={offsetX}
                    onChange={e => setOffsetX(e.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Offset Y</label>
                  <input 
                    type="number"
                    placeholder="ex: 444"
                    value={offsetY}
                    onChange={e => setOffsetY(e.target.value)}
                    disabled={isSubmitting}
                    required
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </div>

              {/* Custom Wplace URL */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Lien wplace.live de l'emplacement (facultatif)</label>
                <input 
                  type="url"
                  placeholder="ex: https://wplace.live/?lat=5.00&lng=-12.50&zoom=12"
                  value={wplaceUrl}
                  onChange={e => setWplaceUrl(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50"
                />
              </div>

              {/* Image Picker */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Image modèle (Template)</label>
                <input 
                  type="file"
                  accept="image/png, image/jpeg"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  disabled={isSubmitting}
                  className="hidden"
                />

                <div 
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center border-2 border-dashed border-slate-800 rounded-2xl p-6 bg-slate-950/40 hover:border-teal-500/60 hover:bg-teal-500/[0.02] cursor-pointer transition-all duration-200"
                >
                  {imagePreview ? (
                    <div className="flex flex-col items-center gap-3">
                      <div className="relative group overflow-hidden rounded-xl border border-slate-800 bg-slate-950 p-1 flex-shrink-0">
                        <img src={imagePreview} alt="Preview" className="h-16 w-16 object-contain rounded-lg" />
                        {!isSubmitting && (
                          <button 
                            type="button" 
                            onClick={removeSelectedImage}
                            className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 hover:scale-105 active:scale-95 transition-all"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                      <span className="text-xs font-semibold text-teal-400 truncate max-w-[200px]">
                        {imageFile?.name}
                      </span>
                    </div>
                  ) : (
                    <>
                      <ImageIcon className="h-10 w-10 text-slate-600 mb-2 transition-colors duration-200" />
                      <p className="text-xs font-medium text-slate-400">
                        Glissez-déposez votre image ici, ou <span className="text-teal-400 hover:underline font-semibold">parcourez vos fichiers</span>
                      </p>
                      <p className="text-[10px] text-slate-600 mt-1 font-medium">
                        PNG ou JPG jusqu'à 5MB
                      </p>
                    </>
                  )}
                </div>
              </div>

              <DialogFooter className="pt-4">
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => { setIsModalOpen(false); resetForm(); }}
                  disabled={isSubmitting}
                >
                  Annuler
                </Button>
                <Button 
                  type="submit" 
                  variant="premium"
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Traitement...
                    </>
                  ) : (
                    'Ajouter le dessin'
                  )}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Details Dialog (Color Breakdown) */}
        <Dialog open={!!activeDetailDrawing} onOpenChange={(open) => { if (!open) { setDetailDrawing(null); setChartMousePos(null); } }}>
          {activeDetailDrawing && (
            <DialogContent className="sm:max-w-[850px] w-[95vw] max-h-[95vh] overflow-y-auto scrollbar-thin">
              <DialogHeader>
                <DialogTitle className="text-lg font-bold text-slate-100">
                  Détails & Statistiques
                </DialogTitle>
                <DialogDescription className="text-slate-400 text-xs">
                  Progression et classement pour le dessin <strong className="text-slate-200">{activeDetailDrawing.name}</strong>
                </DialogDescription>
              </DialogHeader>

              {/* Overall stats inside details modal */}
              <div className="grid grid-cols-2 gap-4 my-2">
                <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-3 text-center">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Pixels totaux</div>
                  <div className="text-xl font-extrabold font-mono text-blue-400">
                    {activeDetailDrawing.totalPixels}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-3 text-center">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Progression</div>
                  <div className="text-xl font-extrabold font-mono text-emerald-400">
                    {(((activeDetailDrawing.progress?.[0]?.correctPixels || 0) / activeDetailDrawing.totalPixels) * 100).toFixed(1)}%
                  </div>
                </div>
              </div>

              {/* Tab Selector */}
              <div className="flex border-b border-slate-900 my-3">
                <button
                  type="button"
                  onClick={() => setDetailTab('colors')}
                  className={`flex-1 pb-2.5 text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${
                    detailTab === 'colors'
                      ? 'border-b-2 border-blue-500 text-blue-400'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Couleurs ({sortedColorStats.length})
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTab('contributors')}
                  className={`flex-1 pb-2.5 text-xs font-bold uppercase tracking-wider transition-colors flex items-center justify-center gap-1.5 ${
                    detailTab === 'contributors'
                      ? 'border-b-2 border-blue-500 text-blue-400'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  <Trophy className="h-3.5 w-3.5" />
                  Contributeurs ({activeDetailDrawing.contributors?.length || 0})
                </button>
              </div>

              {/* Real-time Analysis Progress bar (always visible at the top when running) */}
              {activeDetailDrawing.analysisInProgress && (
                <div className="rounded-xl border border-blue-500/20 bg-blue-950/20 p-4 mb-3 space-y-3 shadow-inner">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                      <span className="text-[10px] font-bold text-blue-300 uppercase tracking-wider">Analyse des pixels corrects...</span>
                    </div>
                    <span className="text-xs font-mono font-bold text-blue-400">
                      {activeDetailDrawing.analysisTotal > 0
                        ? `${((activeDetailDrawing.analysisProgress / activeDetailDrawing.analysisTotal) * 100).toFixed(0)}%`
                        : 'Calcul...'}
                    </span>
                  </div>
                  
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-950 border border-slate-900">
                    <div 
                      className="h-full rounded-full bg-blue-500 transition-all duration-300 shadow-[0_0_8px_rgba(59,130,246,0.4)]"
                      style={{ 
                        width: activeDetailDrawing.analysisTotal > 0 
                          ? `${(activeDetailDrawing.analysisProgress / activeDetailDrawing.analysisTotal) * 100}%` 
                          : '10%' 
                      }}
                    />
                  </div>
                  
                  <div className="flex justify-between items-center text-[9px] text-slate-400 font-mono">
                    <span>
                      {activeDetailDrawing.analysisTotal > 0 
                        ? `${activeDetailDrawing.analysisProgress} / ${activeDetailDrawing.analysisTotal} pixels` 
                        : 'Détection des pixels corrects...'}
                    </span>
                    <span className="text-slate-500 italic">Cadencé à 5 req/s (200ms)</span>
                  </div>
                </div>
              )}

              {/* Tabs Content */}
              {detailTab === 'colors' ? (
                <>
                  {/* Sub-header for lists */}
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">
                      Pixels restants à placer par couleur
                    </h4>
                    <p className="text-[10px] text-slate-500">
                      Par ordre d'urgence (les couleurs les plus incomplètes en premier).
                    </p>
                  </div>

                  {/* Grille de tuiles de couleurs compactes (sans défilement individuel) */}
                  <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mt-3">
                    {sortedColorStats.map((color: any) => {
                      const correctCount = color.correctCount || 0;
                      const totalCount = color.pixelCount;
                      const remainingCount = Math.max(0, totalCount - correctCount);
                      const percent = Math.min(100, Math.max(0, (correctCount / totalCount) * 100));

                      return (
                        <div 
                          key={color.id} 
                          className="flex items-center gap-2.5 rounded-xl border border-slate-900 bg-slate-950/40 p-2 hover:border-slate-800 hover:bg-slate-950/60 transition-colors duration-100"
                        >
                          {/* Color Pill */}
                          <div 
                            className="h-6 w-6 rounded-lg border border-white/10 flex-shrink-0 shadow-[inset_0_0_2px_rgba(0,0,0,0.4)]"
                            style={{ 
                              backgroundColor: color.hexColor
                            }}
                            title={color.hexColor}
                          />

                          {/* Info Column */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-1 leading-none">
                              <span className="text-[11px] font-bold text-slate-300 truncate" title={getColorName(color.hexColor)}>
                                {getColorName(color.hexColor)}
                              </span>
                              <span className={`text-[10px] font-bold font-mono flex-shrink-0 ${
                                remainingCount > 0 ? 'text-slate-400' : 'text-emerald-400'
                              }`}>
                                {remainingCount > 0 ? `+${remainingCount}` : '✓'}
                              </span>
                            </div>
                            
                            {/* Visual Progress details in micro format */}
                            <div className="mt-1 flex items-center gap-1.5 leading-none">
                              <div className="h-1 flex-1 overflow-hidden rounded-full bg-slate-900 border border-slate-950">
                                <div 
                                  className="h-full rounded-full transition-all duration-300"
                                  style={{ 
                                    width: `${percent}%`,
                                    backgroundColor: color.hexColor
                                  }}
                                />
                              </div>
                              <span className="text-[8px] font-mono text-slate-500 leading-none">
                                {percent.toFixed(0)}%
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="space-y-3">
                  {/* Header and Toggle Chart Button Row */}
                  <div className="flex flex-col sm:flex-row gap-2.5">
                    {/* Header with last run and update button */}
                    <div className="flex-1 flex items-center justify-between text-xs bg-slate-950/30 border border-slate-900 rounded-xl p-3">
                      <div className="space-y-0.5">
                        <div className="font-bold text-slate-500 uppercase tracking-wider text-[9px]">Dernier scan</div>
                        <div className="font-mono text-slate-300 text-xs">
                          {activeDetailDrawing.analysisLastRun ? formatDate(activeDetailDrawing.analysisLastRun) : 'Jamais analysé'}
                        </div>
                      </div>
                      
                      {isAdmin ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleTriggerAnalysis(activeDetailDrawing.id)}
                          disabled={activeDetailDrawing.analysisInProgress || isTriggeringAnalysis}
                          className="h-8 border-slate-800 bg-slate-900/40 hover:bg-slate-800 text-xs font-bold text-slate-200"
                        >
                          {isTriggeringAnalysis ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                              Lancement...
                            </>
                          ) : activeDetailDrawing.analysisInProgress ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                              Scan en cours...
                            </>
                          ) : (
                            'Mettre à jour'
                          )}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled
                          className="h-8 border-slate-900 bg-slate-950/20 text-xs font-semibold text-slate-500 cursor-not-allowed flex items-center gap-1.5"
                        >
                          <Lock className="h-3 w-3 text-slate-600" />
                          Mettre à jour (Admin)
                        </Button>
                      )}
                    </div>

                    {/* Chart toggle button */}
                    {activeDetailDrawing.contributors && activeDetailDrawing.contributors.length > 0 && (
                      <Button
                        onClick={() => setShowChart(!showChart)}
                        variant="outline"
                        className="border-slate-800 bg-slate-900/40 hover:bg-slate-800 text-xs font-bold text-slate-200 flex items-center justify-center gap-1.5 h-auto py-2.5 sm:py-0 px-4 rounded-xl shadow-lg hover:text-white"
                      >
                        <BarChart2 className="h-4 w-4 text-teal-400" />
                        {showChart ? 'Masquer le graphique' : 'Afficher le graphique'}
                      </Button>
                    )}
                  </div>

                  {/* Dynamic Stacked Bar Chart */}
                  {showChart && activeDetailDrawing.contributors && activeDetailDrawing.contributors.length > 0 && (
                    <div className="rounded-xl border border-slate-900 bg-slate-950/60 p-4 shadow-inner animate-[fadeIn_0.2s_ease-out]">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-3">Répartition des couleurs par contributeur</div>
                      <div className="h-64 w-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart 
                            data={chartData} 
                            margin={{ top: 10, right: 10, left: -20, bottom: 5 }}
                            onMouseMove={(state: any) => {
                              if (state && state.chartX !== undefined && state.chartY !== undefined) {
                                setChartMousePos({ x: state.chartX + 15, y: state.chartY - 10 });
                              } else {
                                setChartMousePos(null);
                              }
                            }}
                            onMouseLeave={() => setChartMousePos(null)}
                          >
                            <XAxis 
                              dataKey="name" 
                              stroke="#64748b" 
                              fontSize={9} 
                              tickLine={false} 
                              axisLine={false}
                            />
                            <YAxis 
                              stroke="#64748b" 
                              fontSize={9} 
                              tickLine={false} 
                              axisLine={false}
                              allowDecimals={false}
                            />
                            <RechartsTooltip 
                              content={<CustomTooltip />}
                              cursor={false}
                              position={chartMousePos || undefined}
                            />
                            {Array.from(allUniqueColors).map((color) => (
                              <Bar 
                                key={color} 
                                dataKey={color} 
                                stackId="a" 
                                fill={color} 
                                name={getColorName(color)} 
                                radius={[2, 2, 0, 0]}
                                activeBar={false}
                              />
                            ))}
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}

                  {/* Leaderboard scroll area */}
                  <div className="space-y-2 max-h-[450px] overflow-y-auto pr-1.5 scrollbar-thin">
                    {!activeDetailDrawing.contributors || activeDetailDrawing.contributors.length === 0 ? (
                      <div className="text-center py-8 rounded-xl border border-dashed border-slate-900 bg-slate-950/20 flex flex-col items-center justify-center p-4">
                        <p className="text-xs text-slate-500 mb-3">Aucune statistique disponible pour ce dessin.</p>
                        {activeDetailDrawing.analysisInProgress ? (
                          <div className="flex items-center gap-2 text-xs font-semibold text-blue-400">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Scan en cours...
                          </div>
                        ) : isAdmin ? (
                          <Button
                            size="sm"
                            onClick={() => handleTriggerAnalysis(activeDetailDrawing.id)}
                            disabled={isTriggeringAnalysis}
                            className="bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs"
                          >
                            {isTriggeringAnalysis ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                                Démarrage...
                              </>
                            ) : (
                              'Lancer l\'analyse'
                            )}
                          </Button>
                        ) : (
                          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/5 border border-amber-500/20 text-[11px] font-medium text-amber-500/80 shadow-[0_0_8px_rgba(245,158,11,0.05)]">
                            <Lock className="h-3.5 w-3.5 text-amber-500/70" />
                            Mode administrateur requis pour lancer le scan
                          </div>
                        )}
                      </div>
                    ) : (
                      activeDetailDrawing.contributors.map((contrib: any, idx: number) => {
                        let medal = '';
                        let rankColor = 'text-slate-400';
                        let borderStyle = 'border-slate-900 bg-slate-950/40';
                        
                        if (idx === 0) {
                          medal = '🥇';
                          rankColor = 'text-amber-400 font-extrabold';
                          borderStyle = 'border-amber-500/20 bg-amber-500/5 hover:border-amber-500/30';
                        } else if (idx === 1) {
                          medal = '🥈';
                          rankColor = 'text-slate-300 font-extrabold';
                          borderStyle = 'border-slate-300/20 bg-slate-300/5 hover:border-slate-300/30';
                        } else if (idx === 2) {
                          medal = '🥉';
                          rankColor = 'text-amber-700 font-extrabold';
                          borderStyle = 'border-amber-700/20 bg-amber-700/5 hover:border-amber-700/30';
                        }

                        const isExpanded = expandedContributor === contrib.username;
                        const rawColors = contrib.colors;
                        const parsedColors = typeof rawColors === 'object' && rawColors !== null ? (rawColors as Record<string, number>) : {};
                        const hasColors = Object.keys(parsedColors).length > 0;

                        return (
                          <div 
                            key={contrib.id} 
                            onClick={() => {
                              if (hasColors) {
                                setExpandedContributor(isExpanded ? null : contrib.username);
                              }
                            }}
                            className={`flex flex-col rounded-xl border transition-all duration-250 ${hasColors ? 'cursor-pointer select-none' : ''} ${borderStyle}`}
                          >
                            {/* Header Row */}
                            <div className="flex items-center justify-between px-3.5 py-2.5">
                              <div className="flex items-center gap-3 min-w-0">
                                {medal ? (
                                  <span className="text-base leading-none">{medal}</span>
                                ) : (
                                  <span className="text-[10px] font-mono font-bold text-slate-500 w-5 text-center">#{idx + 1}</span>
                                )}
                                <span className={`text-xs font-bold truncate ${rankColor}`}>
                                  {contrib.username}
                                </span>
                              </div>
                              
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <div className="text-right">
                                  <span className="text-xs font-extrabold font-mono text-slate-200">
                                    {contrib.pixelCount}
                                  </span>
                                  <span className="text-[10px] text-slate-500 ml-1">pixel{contrib.pixelCount > 1 ? 's' : ''}</span>
                                </div>
                                {hasColors && (
                                  <span className={`text-[10px] text-slate-500 font-bold transition-transform duration-250 ${isExpanded ? 'rotate-180 text-blue-400' : ''}`}>
                                    ▼
                                  </span>
                                )}
                              </div>
                            </div>

                            {/* Collapsible Color Breakdown */}
                            {isExpanded && hasColors && (
                              <div 
                                onClick={(e) => e.stopPropagation()} // Prevent clicking the breakdown from collapsing the card
                                className="px-3.5 pb-3 pt-1.5 border-t border-slate-900/50 bg-slate-950/25 rounded-b-xl flex flex-wrap gap-2 animate-[fadeIn_0.15s_ease-out]"
                              >
                                {Object.entries(parsedColors).map(([colorHex, count]) => (
                                  <div 
                                    key={colorHex}
                                    className="flex items-center gap-1.5 rounded-lg border border-slate-900/80 bg-slate-950/60 px-2 py-1 shadow-inner hover:border-slate-800/80 transition-colors"
                                  >
                                    <div 
                                      className="h-3 w-3 rounded-full border border-white/10 flex-shrink-0"
                                      style={{ backgroundColor: colorHex }}
                                      title={colorHex}
                                    />
                                    <span className="text-[10px] font-bold text-slate-300">
                                      {getColorName(colorHex)}
                                    </span>
                                    <span className="text-[9px] font-extrabold font-mono text-teal-400 ml-1 bg-teal-500/10 px-1.5 py-0.5 rounded-md">
                                      {count}
                                    </span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              <DialogFooter className="mt-4">
                <Button 
                  type="button" 
                  onClick={() => { setDetailDrawing(null); setChartMousePos(null); }}
                  className="w-full"
                >
                  Fermer
                </Button>
              </DialogFooter>
            </DialogContent>
          )}
        </Dialog>

        {/* Password Modal */}
        <Dialog open={isPasswordModalOpen} onOpenChange={(open) => { if (!open) { setIsPasswordModalOpen(false); setAdminPassword(''); setPasswordError(null); } }}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="text-lg font-bold text-slate-100">
                Connexion Administration
              </DialogTitle>
              <DialogDescription className="text-slate-400 text-xs">
                Veuillez saisir le mot de passe administrateur pour accéder aux fonctions de modification et suppression.
              </DialogDescription>
            </DialogHeader>

            {passwordError && (
              <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{passwordError}</span>
              </div>
            )}

            <form onSubmit={handleAdminLogin} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Mot de passe</label>
                <input 
                  type="password"
                  placeholder="Saisissez le mot de passe"
                  value={adminPassword}
                  onChange={e => setAdminPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
                  autoFocus
                />
              </div>

              <DialogFooter className="pt-2">
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => { setIsPasswordModalOpen(false); setAdminPassword(''); setPasswordError(null); }}
                >
                  Annuler
                </Button>
                <Button 
                  type="submit" 
                  variant="premium"
                >
                  Valider
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* Edit Drawing Modal */}
        <Dialog open={!!editDrawing} onOpenChange={(open) => { if (!open && !isSavingEdit) setEditDrawing(null); }}>
          {editDrawing && (
            <DialogContent className="sm:max-w-[500px]">
              <DialogHeader>
                <DialogTitle className="text-lg font-bold text-slate-100">
                  Modifier le dessin
                </DialogTitle>
                <DialogDescription className="text-slate-400 text-xs">
                  Modifiez le nom et l'emplacement de ce dessin sur la carte.
                </DialogDescription>
              </DialogHeader>

              {editError && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>{editError}</span>
                </div>
              )}

              <form onSubmit={handleEditSubmit} className="space-y-4">
                {/* Nom */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Nom du dessin</label>
                  <input 
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    disabled={isSavingEdit}
                    required
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50"
                  />
                </div>

                {/* Pseudo */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Pseudo du créateur</label>
                  <input 
                    type="text"
                    value={editPseudo}
                    onChange={e => setEditPseudo(e.target.value)}
                    disabled={isSavingEdit}
                    required
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50"
                  />
                </div>

                {/* Chunks */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Chunk X</label>
                    <input 
                      type="number"
                      value={editChunkX}
                      onChange={e => setEditChunkX(e.target.value)}
                      disabled={isSavingEdit}
                      required
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Chunk Y</label>
                    <input 
                      type="number"
                      value={editChunkY}
                      onChange={e => setEditChunkY(e.target.value)}
                      disabled={isSavingEdit}
                      required
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                </div>

                {/* Offsets */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Offset X</label>
                    <input 
                      type="number"
                      value={editOffsetX}
                      onChange={e => setEditOffsetX(e.target.value)}
                      disabled={isSavingEdit}
                      required
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Offset Y</label>
                    <input 
                      type="number"
                      value={editOffsetY}
                      onChange={e => setEditOffsetY(e.target.value)}
                      disabled={isSavingEdit}
                      required
                      className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                </div>

                {/* Custom Wplace URL */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Lien wplace.live de l'emplacement (facultatif)</label>
                  <input 
                    type="url"
                    placeholder="ex: https://wplace.live/?lat=5.00&lng=-12.50&zoom=12"
                    value={editWplaceUrl}
                    onChange={e => setEditWplaceUrl(e.target.value)}
                    disabled={isSavingEdit}
                    className="w-full rounded-xl border border-slate-800 bg-slate-950 px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500 disabled:opacity-50"
                  />
                </div>

                <DialogFooter className="pt-4">
                  <Button 
                    type="button" 
                    variant="outline" 
                    onClick={() => setEditDrawing(null)}
                    disabled={isSavingEdit}
                  >
                    Annuler
                  </Button>
                  <Button 
                    type="submit" 
                    variant="premium"
                    disabled={isSavingEdit}
                  >
                    {isSavingEdit ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Enregistrement...
                      </>
                    ) : (
                      'Sauvegarder'
                    )}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          )}
        </Dialog>

        {/* Delete Confirmation Modal */}
        <Dialog open={!!deleteDrawing} onOpenChange={(open) => { if (!open && !isDeleting) setDeleteDrawing(null); }}>
          {deleteDrawing && (
            <DialogContent className="sm:max-w-[420px]">
              <DialogHeader>
                <DialogTitle className="text-lg font-bold text-slate-100">
                  Supprimer le dessin
                </DialogTitle>
                <DialogDescription className="text-slate-400 text-xs">
                  Êtes-vous sûr de vouloir supprimer <strong className="text-slate-200">{deleteDrawing.name}</strong> ? Cette action est irréversible et supprimera tout l'historique associé.
                </DialogDescription>
              </DialogHeader>

              <DialogFooter className="pt-4">
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => setDeleteDrawing(null)}
                  disabled={isDeleting}
                >
                  Annuler
                </Button>
                <Button 
                  type="button" 
                  variant="destructive"
                  onClick={handleDeleteConfirm}
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Suppression...
                    </>
                  ) : (
                    'Supprimer'
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          )}
        </Dialog>
      </div>

      <style jsx global>{`
        .scrollbar-thin::-webkit-scrollbar {
          width: 5px;
        }
        .scrollbar-thin::-webkit-scrollbar-track {
          background: transparent;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 9999px;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
        
        @keyframes spin-slow {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-spin-slow {
          animation: spin-slow 8s linear infinite;
        }
      `}</style>
    </div>
  );
}
